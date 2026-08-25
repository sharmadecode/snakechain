import { FoodManager, FoodItem } from "./food.js";
import { Player } from "./player.js";
import { Bot, BotContext } from "./bot.js";
import { Grid } from "./grid.js";
import * as C from "./config.js";
import { dist2, pointSegDist2 } from "./vec.js";

export interface ClientHandle {
  send(data: string): void;
  /** Client-reported viewport radius (world units), clamped server-side. */
  viewR: number;
  /** Players whose authoritative body has already been sent to this client
      (reset on re-join; re-entry after leaving view re-sends immediately). */
  bodyKnown: Set<number>;
  /** Food ids this client has been told about (spawn snapshot, batch events
      and keep-sync all maintain it). The periodic keep-sync diffs against
      this instead of re-sending the whole view every FOOD_SYNC_MS. */
  foodKnown: Set<number>;
  /** Spectate-on-death: while this client's snake is DEAD, interest filtering
      centers on THIS player id instead of the corpse — otherwise the watched
      killer stops streaming after the client TTL sweep (~3s). */
  spectatePid: number;
}

export interface KillFeedEvent {
  killer: Player | null;
  victim: Player;
  wall: boolean;
}

export interface DeadStats {
  kills: number;
  timeMs: number;
  maxLen: number;
  rank: number;
  killerName: string | null;
  killerId: number;
  wall: boolean;
}

interface SegEntry {
  p: Player;
  i: number;
  cells: number[];
}

/** Distance tiering: actors farther than this from a client stream state
    rows at half rate (~15Hz). Nearby combat stays at full ~30Hz. */
const TIER_DIST2 = 900 * 900;

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Single wire-format builder for food rows — used by the join snapshot,
    the periodic keep-sync and the batched event flush so all three can
    never drift apart. `now` stamps the death-drop glow window. */
function foodRow(f: FoodItem, now: number): string {
  const isDrop = f.isDeathDrop && now - f.dropAt < C.DEATH_DROP_GLOW_MS ? 1 : 0;
  // Golden flag appended ONLY when set — keeps ordinary rows byte-identical
  // with pre-golden clients.
  const gold = f.isGolden ? ",1" : "";
  return `[${f.id},${r1(f.x)},${r1(f.y)},${f.colorIdx},${isDrop}${gold}]`;
}

let sessionSeq = 1;

export class Session {
  readonly id: string;
  readonly players = new Map<number, Player>();
  readonly humans = new Map<number, Player>();
  readonly clients = new Map<number, ClientHandle>();
  readonly food = new FoodManager();
  halfW = C.WORLD_HALF;
  halfH = C.WORLD_HALF;

  private grid = new Grid<FoodItem | SegEntry>(48);
  private tickId: NodeJS.Timeout | null = null;
  private killfeeds: KillFeedEvent[] = [];
  /** Food events accumulated since the last FOOD_EVENT_BATCH flush. */
  private batchSpawned: FoodItem[] = [];
  private batchRemoved: Array<{ id: number; x: number; y: number }> = [];
  /** Real deaths queued for the per-tick `df` broadcast. */
  private deathEvents: Array<{ victim: Player; x: number; y: number }> = [];
  private deadStats = new Map<number, DeadStats>();
  private lastLbAt = 0;
  private lastFoodSyncAt = 0;
  // --- Battle-Royale collapse state (see config BR_*) ---
  private brTargetHalfW = C.WORLD_HALF;
  private brNextShrinkAt = Date.now() + C.BR_FIRST_DELAY_MS;
  private brHoldUntil = 0;
  /** Champion announcement queued for the next flush (name is server-known). */
  private pendingChamp: { id: number; name: string } | null = null;
  /** Last targetLen at which each player's body was sampled for clients
      (growth > BODY_GROWTH_RESEND forces an immediate refresh). */
  private bodyLenAt = new Map<number, number>();
  private tickNo = 0;
  private perfAcc = 0;
  private perfSamples = 0;
  private lastPerfLog = 0;
  /** Consecutive step() exceptions (EH-01): a permanent fault must be
      visible on /health instead of limping silently at 30 logs/sec. */
  private tickErrStreak = 0;
  /** Wall-clock ms of the most recent tick() fire — backs /health's
      sinceLastTickMs so a wedged interval is detectable from outside. */
  private lastStepWallMs = 0;
  private accMs = 0;
  private lastTickAt: number | null = null;
  private ctx: BotContext;

  readonly mode: "classic" | "br";

  constructor(mode: "classic" | "br" = "classic") {
    this.mode = mode;
    this.id = `s${sessionSeq++}:${mode}`;
    this.ctx = {
      alivePlayers: [],
      getHalfW: () => this.halfW,
      getHalfH: () => this.halfH,
      findFood: (x: number, y: number, radius: number) => {
        let best: FoodItem | null = null;
        let bestD2 = radius * radius;
        const dropCutoff = Date.now() - C.FOOD_DROP_BOT_IGNORE_MS;
        this.grid.forEachNear(x, y, radius, (item) => {
          if (!(item instanceof FoodItem)) return;
          if (item.dropAt > dropCutoff) return;
          const dx = item.x - x;
          const dy = item.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = item;
          }
        });
        return best;
      },
    };
  }

  start(): void {
    this.tickId = setInterval(() => this.tick(), C.TICK_MS);
  }

  stop(): void {
    if (this.tickId) clearInterval(this.tickId);
    this.tickId = null;
  }

  get aliveCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.alive) n++;
    return n;
  }

  botCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.isBot) n++;
    return n;
  }

  /** Cheap O(players) snapshot for the /health endpoint. */
  healthStats(): {
    humans: number; bots: number; alive: number; food: number;
    tickErrStreak: number; tickMsAvg: number; sinceLastTickMs: number;
  } {
    return {
      humans: this.humans.size,
      bots: this.botCount(),
      alive: this.aliveCount,
      food: this.food.items.size,
      tickErrStreak: this.tickErrStreak,
      tickMsAvg: this.perfSamples > 0 ? +(this.perfAcc / this.perfSamples).toFixed(2) : -1,
      sinceLastTickMs: this.lastStepWallMs > 0 ? Date.now() - this.lastStepWallMs : -1,
    };
  }

  /** Register a human client. Respawns the player if they were dead. */
  addHuman(player: Player, client: ClientHandle, spawn: boolean): void {
    this.players.set(player.id, player);
    this.humans.set(player.id, player);
    this.clients.set(player.id, client);
    if (spawn) this.spawnPlayer(player);
  }

  removeHuman(playerId: number): void {
    const p = this.players.get(playerId);
    if (!p) return;
    if (p.alive) {
      // Disconnect/quit while alive: clients have no other removal signal
      // ("absence from `s` is not death"), so emit the same `df` a real
      // death gets. Deliberately NO killfeed and NO loot drop — nobody
      // earned the kill, and drops would make quitting farmable.
      p.die("crash");
      this.deathEvents.push({ victim: p, x: p.x, y: p.y });
    }
    this.removeSegsFromGrid(p);
    this.players.delete(playerId);
    this.humans.delete(playerId);
    this.clients.delete(playerId);
    this.deadStats.delete(playerId);
    this.bodyLenAt.delete(playerId);
    this.pendingSpawns.delete(playerId);
  }

  adjustBots(desired: number): void {
    const bots: Bot[] = [];
    for (const p of this.players.values()) if (p.isBot) bots.push(p as Bot);
    while (bots.length > desired) {
      const b = bots.pop()!;
      this.despawnBot(b);
    }
    while (bots.length < desired) {
      const b = new Bot();
      this.players.set(b.id, b);
      this.spawnPlayer(b);
      bots.push(b);
    }
  }

  private pendingSpawns = new Map<number, number>();

  private despawnBot(b: Bot): void {
    if (b.alive) {
      b.die("crash");
      // Capacity despawns drop no food and emit no killfeed, but clients
      // MUST still get the `df` event — it is the only client-side removal
      // signal; absence from the `s` broadcast is not death.
      this.deathEvents.push({ victim: b, x: b.x, y: b.y });
    }
    this.removeSegsFromGrid(b);
    this.pendingSpawns.delete(b.id);
    this.bodyLenAt.delete(b.id);
    this.deadStats.delete(b.id);
    this.players.delete(b.id);
  }

  /** Attempt to spawn at a safe spot. Returns false when no safe spot
      exists (caller must retry later — never force a spawn). */
  spawnPlayer(p: Player): boolean {
    const pos = this.safeSpawn(!p.isBot);
    if (!pos) {
      this.pendingSpawns.set(p.id, Date.now() + 400);
      return false;
    }
    this.pendingSpawns.delete(p.id);
    p.spawn(
      pos[0],
      pos[1],
      Math.random() * Math.PI * 2,
      p.isBot ? C.BOT_START_LENGTH : C.START_LENGTH,
    );
    return true;
  }

  /** Retry deferred spawns whose cooldown elapsed (empty spot appears). */
  private flushPendingSpawns(): void {
    if (!this.pendingSpawns.size) return;
    const now = Date.now();
    for (const [id, at] of [...this.pendingSpawns]) {
      if (now < at) continue;
      const p = this.players.get(id);
      if (!p || p.alive) {
        this.pendingSpawns.delete(id);
        continue;
      }
      this.spawnPlayer(p);
    }
  }

  /**
   * Re-registers all active body segments of a player in the spatial grid every tick.
   * Chain model: px[0] IS the head, so consecutive index pairs span the whole
   * body including head→neck. Guarantees accurate, drift-free collision detection.
   */
  private updateSegsInGrid(p: Player): void {
    this.removeSegsFromGrid(p);
    const n = p.px.length;
    if (n < 2) return;
    const keep: SegEntry[] = [];
    for (let i = 0; i + 1 < n; i += C.BODY_SEGMENT_STRIDE) {
      const cells = this.grid.segmentCells(p.px[i]!, p.py[i]!, p.px[i + 1]!, p.py[i + 1]!);
      const e: SegEntry = { p, i, cells };
      this.grid.insertInto(cells, e);
      keep.push(e);
    }
    p.gridSegs = keep;
  }

  private removeSegsFromGrid(p: Player): void {
    for (const e of p.gridSegs) this.grid.removeFrom(e.cells, e);
    p.gridSegs = [];
  }

  private safeSpawn(isHumanSpawner: boolean): [number, number] | null {
    // Unified clearances (bots were previously held to HALF these distances
    // in the fallback path, which let them materialize right in front of a
    // moving snake). Predicted-head checks also keep spawns out of the path
    // of anything barreling toward the spot.
    const headClear = isHumanSpawner ? 420 : 380;
    const bodyClear = isHumanSpawner ? 300 : 260;
    const nearBody = (x: number, y: number): boolean => {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        if (dist2(x, y, p.x, p.y) < headClear * headClear) return true;
        // Where the head will be: prevX/Y is one tick of travel, so k=14
        // ≈ 0.47s ahead at base speed (~80u) and k=30 ≈ 1s boosted (~320u).
        const vx = p.x - p.prevX;
        const vy = p.y - p.prevY;
        if (dist2(x, y, p.x + vx * 14, p.y + vy * 14) < headClear * headClear) return true;
        if (dist2(x, y, p.x + vx * 30, p.y + vy * 30) < headClear * headClear) return true;
        for (let i = 0; i < p.px.length; i += 2) {
          if (dist2(x, y, p.px[i]!, p.py[i]!) < bodyClear * bodyClear) return true;
        }
      }
      return false;
    };
    for (let tries = 0; tries < 25; tries++) {
      const rad = Math.sqrt(Math.random()) * (this.halfW - 220);
      const th = Math.random() * Math.PI * 2;
      const x = Math.cos(th) * rad;
      const y = Math.sin(th) * rad;
      if (!nearBody(x, y)) return [x, y];
    }
    // Fallback: farthest spot from heads AND bodies (stride 4). The minimum
    // accepted clearance is the FULL bodyClear for everyone — never the old
    // 170u bot special-case that read as "spawned on top of me". If nothing
    // clears it, the caller retries later instead of force-spawning.
    const minClear = bodyClear;
    let best: [number, number] | null = null;
    let bestD = minClear * minClear;
    for (let i = 0; i < 40; i++) {
      const rad = Math.sqrt(Math.random()) * (this.halfW - 160);
      const th = Math.random() * Math.PI * 2;
      const x = Math.cos(th) * rad;
      const y = Math.sin(th) * rad;
      let md = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const hd = dist2(x, y, p.x, p.y);
        if (hd < md) md = hd;
        for (let j = 0; j < p.px.length; j += 4) {
          const d2 = dist2(x, y, p.px[j]!, p.py[j]!);
          if (d2 < md) md = d2;
        }
      }
      if (md > bestD) {
        bestD = md;
        best = [x, y];
      }
    }
    return best;
  }

  private tick(): void {
    this.lastStepWallMs = Date.now();
    const now = performance.now();
    if (this.lastTickAt !== null) this.accMs += now - this.lastTickAt;
    else this.accMs = C.TICK_MS;
    this.lastTickAt = now;
    // Fixed-timestep catch-up: if the OS timer fired late (Windows timer
    // coalescing, load spikes), step enough times to stay wall-clock
    // accurate. Movement stays per-step constant, so collisions never tunnel.
    let steps = 0;
    while (this.accMs >= C.TICK_MS - 0.05 && steps < 5) {
      this.step();
      this.accMs -= C.TICK_MS;
      steps++;
    }
    if (steps >= 5) this.accMs = Math.min(this.accMs, C.TICK_MS);
    // Broadcast the latest state once per timer fire (not per step) so rows
    // arrive at a steady wall-clock rate even when several catch-up steps
    // ran back-to-back. Burst rows make clients misestimate velocity and
    // cause visible jitter.
    try {
      this.broadcastState();
    } catch (err) {
      console.error("[session] broadcast error", err);
    }
  }

  private step(): void {
    const t0 = performance.now();
    try {
      this.tickNo++;
      const dt = C.TICK_MS / 1000;
      // Hoisted once per tick — spawn-protection checks below compare against
      // this instead of calling Date.now() per visited grid item / pair.
      const nowMs = Date.now();
      this.brTick(dt);

      const alive: Player[] = [];
      for (const p of this.players.values()) if (p.alive) alive.push(p);
      this.ctx.alivePlayers = alive;

      for (const p of this.players.values()) {
        if (!p.isBot) continue;
        const b = p as Bot;
        if (!b.alive) {
          if (Date.now() >= b.respawnAt && !this.pendingSpawns.has(b.id)) this.spawnPlayer(b);
        } else {
          b.update(dt, this.ctx);
        }
      }

      this.flushPendingSpawns();

      for (const p of alive) {
        p.move(dt);
        const drop = p.checkBoostDrop();
        if (drop) {
          this.food.addBoostDrop(drop[0], drop[1], p.colorIdx);
        }
      }

      for (const p of alive) {
        // Wall kill: the arena is a circle of radius halfW (halfH is kept
        // equal and only broadcast for client-side math). Fresh-spawn
        // protection applies here too — a protected snake gets the window to
        // orient itself before the boundary turns lethal.
        if (p.x * p.x + p.y * p.y > this.halfW * this.halfW && nowMs >= p.spawnProtectUntil) {
          this.killPlayer(p, null, true);
        }
      }

      // Differential collision grid: sync each player's strided body
      // segments (dead players get theirs removed). Food is synced at
      // flushEvents time — spawned and eaten items only, never a rebuild.
      for (const p of this.players.values()) {
        if (p.alive) this.updateSegsInGrid(p);
        else this.removeSegsFromGrid(p);
      }

      const eaten = new Set<number>();
      for (const p of alive) {
        const r = p.headRadius();
        const query = r + Math.max(C.FOOD_EAT_MARGIN, C.THICK_MAX / 2);
        this.grid.forEachNear(p.x, p.y, query, (item) => {
          if (item instanceof FoodItem) {
            if (!eaten.has(item.id) && dist2(p.x, p.y, item.x, item.y) < (r + C.FOOD_EAT_MARGIN) ** 2) {
              eaten.add(item.id);
              this.food.remove(item.id);
              p.eat(item.value);
            }
          } else if (
            item.p !== p &&
            nowMs >= item.p.spawnProtectUntil &&
            nowMs >= p.spawnProtectUntil
          ) {
            // Protected snakes are harmless AND invulnerable: their bodies
            // can't kill (no free shield-ramming) and their head can't die.
            const seg = item;
            // Chain model: plain 0-based segment pairs (no legacy -1 neck case).
            const x1 = seg.p.px[seg.i]!;
            const y1 = seg.p.py[seg.i]!;
            const x2 = seg.p.px[seg.i + 1]!;
            const y2 = seg.p.py[seg.i + 1]!;
            const d2 = pointSegDist2(p.x, p.y, x1, y1, x2, y2);
            // Body radius thick*0.5 matches the rendered box width.
            // If the head's front edge touches the opponent's body segment:
            if (d2 < (r + seg.p.thick * 0.48) ** 2) {
              const q = seg.p;
              const headTouch =
                seg.i <= 0 &&
                dist2(p.x, p.y, q.x, q.y) < (p.headRadius() + q.headRadius()) ** 2;
              if (!headTouch) this.killPlayer(p, q, false);
            }
          }
        });
      }

      const stillAlive: Player[] = [];
      for (const p of this.players.values()) if (p.alive) stillAlive.push(p);
      for (let i = 0; i < stillAlive.length; i++) {
        for (let j = i + 1; j < stillAlive.length; j++) {
          const a = stillAlive[i]!;
          const b = stillAlive[j]!;
          const rr = a.headRadius() + b.headRadius();
          if (dist2(a.x, a.y, b.x, b.y) >= rr * rr) continue;
          // Spawn protection applies to head-on clashes too — neither party
          // can die while protected (no shield-ramming in either direction).
          if (nowMs < a.spawnProtectUntil || nowMs < b.spawnProtectUntil) continue;
          // Head-to-head: only the first toucher dies (the head that bites
          // the other first), the survivor gets the kill credit. Resolved
          // by each head's closing speed toward the other over this tick —
          // the one that closes the gap faster is the one that touches
          // first. Perfect dead-on ties go to the smaller snake.
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dd = Math.hypot(dx, dy) || 1;
          const closeA = ((a.x - a.prevX) * dx + (a.y - a.prevY) * dy) / dd;
          const closeB = -((b.x - b.prevX) * dx + (b.y - b.prevY) * dy) / dd;
          let loser: Player;
          let winner: Player;
          if (closeA > closeB + 1e-6) {
            loser = a;
            winner = b;
          } else if (closeB > closeA + 1e-6) {
            loser = b;
            winner = a;
          } else {
            loser = a.targetLen <= b.targetLen ? a : b;
            winner = loser === a ? b : a;
          }
          this.killPlayer(loser, winner, false);
        }
      }

      const targetFood = Math.min(C.FOOD_CAP, Math.max(1800, stillAlive.length * C.FOOD_PER_ACTOR));
      const missing = targetFood - this.food.items.size;
      if (missing > 0) {
        this.food.queueSpawn(Math.min(missing, C.FOOD_SPAWN_PER_TICK));
      }
      this.spawnFood();

      this.foodKeepSync();
      this.flushEvents();

      if (Date.now() - this.lastLbAt >= C.LEADERBOARD_INTERVAL_MS) {
        this.lastLbAt = Date.now();
        this.broadcastLeaderboard();
      }
      // Reached only on a fully successful step — any throw above leaves
      // the streak elevated for /health to surface.
      this.tickErrStreak = 0;
    } catch (err) {
      this.tickErrStreak++;
      console.error("[session] tick error", err);
    }
    const dt = performance.now() - t0;
    this.perfAcc += dt;
    this.perfSamples++;
    // Rolling perf summary: 10 s cadence under STRESS for tuning, a quiet
    // 60 s heartbeat in production so incidents are diagnosable from logs
    // alone (previously production was completely mute here).
    const logEveryMs = process.env.STRESS === "1" ? 10_000 : 60_000;
    if (this.perfSamples >= 30 && Date.now() - this.lastPerfLog > logEveryMs) {
      this.lastPerfLog = Date.now();
      console.log(
        `[perf] ${this.id}: ${(this.perfAcc / this.perfSamples).toFixed(2)}ms/tick, ` +
        `${this.players.size} players, ${this.aliveCount} alive, ` +
        `${this.food.items.size} food, errStreak=${this.tickErrStreak}`
      );
      this.perfAcc = 0;
      this.perfSamples = 0;
    }
  }

  /** Periodic authoritative food re-sync per client: every FOOD_SYNC_MS the
      client's view is DIFFED against what it was already told (foodKnown):
      only newly-visible items are sent as "s" rows and items that vanished
      unseen are sent as "r" ids. Wipes out ghosts from events filtered while
      the client was far away, without re-shipping the whole view (~40KB per
      desktop client) every 10 s. Items that merely left the view are kept in
      foodKnown silently — the client still has them and no removal event
      was ever emitted for them. */
  /** Interest focus for a client: its own snake — or, while dead with a
      valid spectate target, the watched LIVE player (spectate death-cam
      needs the server to keep streaming what the client is watching). */
  private interestFocus(c: ClientHandle, pid: number): Player | undefined {
    const me = this.players.get(pid);
    if (!me || me.alive || !c.spectatePid) return me;
    const sp = this.players.get(c.spectatePid);
    return sp && sp.alive ? sp : me;
  }

  private foodKeepSync(): void {
    if (Date.now() - this.lastFoodSyncAt < C.FOOD_SYNC_MS) return;
    this.lastFoodSyncAt = Date.now();
    const now = Date.now();
    for (const [pid, c] of this.clients) {
      const me = this.interestFocus(c, pid);
      if (!me) continue;
      const r = c.viewR + C.INTEREST_SAFETY;
      const v2 = r * r;
      const seen = new Set<number>();
      const rows: string[] = [];
      this.grid.forEachNear(me.x, me.y, r, (item) => {
        if (!(item instanceof FoodItem)) return;
        const dx = item.x - me.x;
        const dy = item.y - me.y;
        if (dx * dx + dy * dy <= v2) {
          seen.add(item.id);
          if (!c.foodKnown.has(item.id)) {
            rows.push(foodRow(item, now));
            c.foodKnown.add(item.id);
          }
        }
      });
      const gone: number[] = [];
      for (const id of c.foodKnown) {
        if (seen.has(id)) continue;
        const item = this.food.items.get(id);
        if (item) {
          // Still exists — just outside the current view circle. The client
          // never got a removal for it, so keep it known; it will be
          // reported gone on a later sync if it really despawned.
          const dx = item.x - me.x;
          const dy = item.y - me.y;
          if (dx * dx + dy * dy > v2) continue;
        }
        c.foodKnown.delete(id);
        gone.push(id);
      }
      if (rows.length > 0 || gone.length > 0) {
        c.send(`{"t":"f","s":[${rows.join(",")}],"r":[${gone.join(",")}]}`);
      }
    }
  }

  private spawnFood(): void {
    const n = this.food.takeQueued();
    for (let i = 0; i < n; i++) {
      for (let tries = 0; tries < C.FOOD_MAX_SPAWN_TRIES; tries++) {
        const rad = Math.sqrt(Math.random()) * (this.halfW - 120);
        const th = Math.random() * Math.PI * 2;
        const x = Math.cos(th) * rad;
        const y = Math.sin(th) * rad;
        let near = false;
        for (const p of this.players.values()) {
          if (p.alive && dist2(x, y, p.x, p.y) < 120 * 120) {
            near = true;
            break;
          }
        }
        if (!near) {
          this.food.add(x, y);
          break;
        }
      }
    }
  }

  private killPlayer(p: Player, killer: Player | null, wall: boolean): void {
    if (!p.alive) return;
    p.die(wall ? "wall" : "crash");
    if (killer && killer.alive) killer.kills++;
    for (const drop of p.dropPositions()) this.food.addDeathDrop(drop.x, drop.y, p.colorIdx, drop.val);
    this.killfeeds.push({ killer, victim: p, wall });
    this.deathEvents.push({ victim: p, x: p.x, y: p.y });
    if (!p.isBot) {
      let rank = 1;
      for (const q of this.players.values()) {
        if (q !== p && q.alive && q.targetLen > p.targetLen) rank++;
      }
      this.deadStats.set(p.id, {
        kills: p.kills,
        timeMs: p.aliveTimeMs,
        maxLen: Math.round(p.targetLen),
        rank,
        killerName: killer ? killer.name : null,
        killerId: killer ? killer.id : 0,
        wall,
      });
    }
    if (p.isBot) (p as Bot).scheduleRespawn();
  }

  /** Battle-Royale collapse driver (see PHASES.md §BR). Steps the target
      radius down on a timer, eases halfW toward it at BR_WALL_SPEED, holds
      at the floor, crowns the #1 as CHAMPION, then re-expands. Fully
      server-timed — clients render everything from existing fields. */
  private brTick(dt: number): void {
    // Battle-Royale collapse only runs in “br”-mode arenas. Classic arenas
    // keep the constant slither-io style map.
    if (this.mode !== "br") return;
    const now = Date.now();

    if (this.brHoldUntil > 0) {
      if (now >= this.brHoldUntil) {
        // Crown whoever leads when the collapse completes.
        let champ: Player | null = null;
        for (const p of this.players.values()) {
          if (p.alive && (!champ || p.targetLen > champ.targetLen)) champ = p;
        }
        if (champ) this.pendingChamp = { id: champ.id, name: champ.name };
        this.brTargetHalfW = C.WORLD_HALF;
        this.brHoldUntil = 0;
        this.brNextShrinkAt = now + C.BR_SHRINK_INTERVAL_MS;
      }
    } else if (now >= this.brNextShrinkAt) {
      const target = Math.max(
        C.BR_MIN_HALFW,
        Math.round(this.brTargetHalfW * C.BR_SHRINK_FACTOR),
      );
      if (target < this.brTargetHalfW - 1) {
        this.brTargetHalfW = target;
        this.purgeFoodOutside(target);
        this.brNextShrinkAt = now + C.BR_SHRINK_INTERVAL_MS;
      } else {
        // Floor reached — hold tight, then crown and re-expand.
        this.brHoldUntil = now + C.BR_HOLD_MS;
      }
    }

    // Ease the live wall toward its target (linear, capped speed).
    const rate = C.BR_WALL_SPEED * dt;
    if (this.halfW > this.brTargetHalfW) {
      this.halfW = Math.max(this.brTargetHalfW, this.halfW - rate);
    } else if (this.halfW < this.brTargetHalfW) {
      this.halfW = Math.min(this.brTargetHalfW, this.halfW + rate);
    }
    this.halfH = this.halfW;
  }

  /** Drop natural/drop food that the collapsed wall left unreachable, so the
      FOOD_CAP economy keeps feeding the playable area. Batched through the
      normal removal path → clients get ordinary removal events. */
  private purgeFoodOutside(radius: number): void {
    const r2 = (radius + 60) * (radius + 60);
    const dead: number[] = [];
    for (const f of this.food.items.values()) {
      if (f.x * f.x + f.y * f.y > r2) dead.push(f.id);
    }
    for (const id of dead) this.food.remove(id);
  }

  private broadcastState(): void {
    // Serialize each alive player's row once per tick, then hand each
    // client only the rows inside its view. Index 11 is an EMPTY string:
    // no client ever read names from these rows (lb/kf/dead messages carry
    // names where they matter), so embedding them 30Ã—/s per visible player
    // was pure bandwidth. The slot stays for wire-format stability.
    //
    // Two row variants per player: the FULL row carries the packed color
    // chain (up to 11 digits) and is sent only on first sight after an
    // interest-entry; the SLIM row carries 0 in that slot (= "unchanged",
    // clients keep their cached value and ignore repeats). colorIdx is
    // immutable per player id, so once-per-connection-per-id is exact.
    const rowBuf = new Map<number, string>();
    const rowBufSlim = new Map<number, string>();
    // Max distance from head to any sampled body point, per player, once
    // per tick. Lets the per-client interest test be a single bounding
    // check instead of a body walk per client per player (O(CÂ·PÂ·L/8) ->
    // O(PÂ·L/8) + O(CÂ·P)).
    const bodyReach = new Map<number, number>();
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const head = `[${p.id},${Math.round(p.x)},${Math.round(p.y)},${r1(p.angle)},${r1(p.targetLen)},${r1(p.thick)},`;
      // Slot 9 is the spawn-protection flag (previously a constant "0" —
      // zero wire-format change, old clients just ignore it).
      const tail = `${p.patternIdx},${p.isBot ? 1 : 0},${p.isProtected() ? 1 : 0},${p.kills},""]`;
      rowBuf.set(p.id, `${head}${p.colorIdx},${tail}`);
      rowBufSlim.set(p.id, `${head}0,${tail}`);
      let maxD2 = 0;
      for (let i = 0; i < p.px.length; i += 8) {
        const dx = p.px[i]! - p.x;
        const dy = p.py[i]! - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > maxD2) maxD2 = d2;
      }
      bodyReach.set(p.id, Math.sqrt(maxD2));
    }
    const base = `{"t":"s","tk":${this.tickNo},"w":[${r1(this.halfW)},${r1(this.halfH)}],"p":[`;
    const bodyCadence = this.tickNo % 3 === 0; // ~10 TPS authoritative refresh
    for (const [pid, c] of this.clients) {
      const me = this.interestFocus(c, pid);
      if (!me) continue;
      // viewR was clamped to [VIEW_FLOOR, VIEW_MAX] at join/view time —
      // no per-tick re-clamping needed.
      const r = c.viewR + C.INTEREST_SAFETY;
      const v2 = r * r;
      let rows = "";
      let first = true;
      const bodyRows: string[] = [];
      for (const [id, row] of rowBuf) {
        const q = this.players.get(id)!;
        // Sync a player if its head OR any body point is within the view
        // radius: a long body can sweep across the client's screen even
        // when the head is far away. The body test uses the precomputed
        // reach circle (a conservative superset of the point walk).
        const dx = q.x - me.x;
        const dy = q.y - me.y;
        const dh2 = dx * dx + dy * dy;
        let inView = dh2 <= v2;
        if (!inView) {
          const reach = r + (bodyReach.get(id) ?? 0);
          inView = dh2 <= reach * reach;
        }
        if (inView) {
          // Distance tiering: actors beyond TIER_DIST stream at half rate
          // (~15Hz). The client's velocity extrapolation absorbs sub-100ms
          // row gaps by design; INTEREST_SAFETY means PRESENCE data is never
          // delayed - only refreshes of already-visible snakes are spaced.
          if (dh2 > TIER_DIST2 && this.tickNo % 2 !== 0) continue;
          // First sight carries the real packed color; afterwards the slim
          // row (0 = unchanged). known is hoisted so both the row choice and
          // the body logic below share it.
          const known = c.bodyKnown.has(id);
          if (!first) rows += ",";
          rows += known ? rowBufSlim.get(id)! : row;
          first = false;
          // Authoritative body: send on first entry into view (before a
          // newly relevant snake can kill this client), on the ~10 TPS
          // cadence while visible, and immediately on significant growth.
          const grew = q.targetLen - (this.bodyLenAt.get(id) ?? 0) > C.BODY_GROWTH_RESEND;
          if (!known || bodyCadence || grew) {
            const bRow = this.bodyRow(q);
            if (bRow) {
              bodyRows.push(bRow);
              c.bodyKnown.add(id);
              this.bodyLenAt.set(id, q.targetLen);
            }
          }
        } else if (c.bodyKnown.delete(id)) {
          // Left view: next entry re-sends immediately (also drops bodies
          // of snakes that died unseen, keeping the set bounded).
        }
      }
      c.send(base + rows + "]}");
      if (bodyRows.length) c.send(`{"t":"b","p":[${bodyRows.join(",")}]}`);
    }
  }

  /** Sample a player's ENTIRE path head->tail, adaptively strided so every
      point of the authoritative body reaches clients no matter how long the
      snake is. The old fixed 22-unit sampling silently truncated bodies
      longer than BODY_SAMPLE_CAP×22 ≈ 3080 units — those unseen sections were
      still lethal server-side (the "invisible killer" reports). Worst-case
      spacing for a MAX_POINTS(800)-point snake is ~60 units, whose chord
      sagitta on even the tightest turn radius (~60u) is ~8u — far below one
      rendered block. Returns null when the path is too short to yield a
      single sample (fresh spawns) — an empty row would emit `[id,x,y,]` and
      break JSON parsing. */
  private bodyRow(p: Player): string | null {
    const n = p.px.length;
    if (n < 2) return null;
    const stride = Math.max(1, Math.ceil(n / C.BODY_SAMPLE_CAP));
    const pts: number[] = [];
    let lastEmitted = -1;
    for (let i = stride; i < n; i += stride) {
      pts.push(r1(p.px[i]!), r1(p.py[i]!));
      lastEmitted = i;
    }
    // Always close with the true tail tip so nothing trails unstreamed.
    if (lastEmitted !== n - 1 && lastEmitted !== -1) {
      pts.push(r1(p.px[n - 1]!), r1(p.py[n - 1]!));
    }
    if (pts.length === 0) return null;
    return `[${p.id},${r1(p.x)},${r1(p.y)},${pts.join(",")}]`;
  }

  private flushEvents(): void {
    const { r, sItems, rItems } = this.food.flushEvents();

    // Differential grid sync: food spawned this tick (fill + death drops)
    // enters the collision grid, eaten food leaves it. Runs every tick.
    for (const f of sItems) this.grid.insert(f.x, f.y, f);
    for (const f of rItems) this.grid.remove(f.x, f.y, f);

    // Accumulate events across the batch window (an item spawned and eaten
    // within the window appears in both lists; clients apply "s" before
    // "r", so it resolves correctly), then flush per-client messages only
    // every FOOD_EVENT_BATCH ticks (~5 Hz) — a 32/tick food fill must not
    // become a 30 TPS message flood.
    for (const f of sItems) this.batchSpawned.push(f);
    for (let i = 0; i < r.length; i++) {
      const f = rItems[i];
      if (f) this.batchRemoved.push({ id: r[i]!, x: f.x, y: f.y });
    }

    if (this.tickNo % C.FOOD_EVENT_BATCH === 0) {
      if (this.batchSpawned.length > 0 || this.batchRemoved.length > 0) {
        const now = Date.now();
        for (const [pid, c] of this.clients) {
          const me = this.interestFocus(c, pid);
          if (!me) continue;
          const vr = c.viewR + C.INTEREST_SAFETY;
          const v2 = vr * vr;
          const sRows: string[] = [];
          for (const f of this.batchSpawned) {
            const dx = f.x - me.x;
            const dy = f.y - me.y;
            if (dx * dx + dy * dy <= v2) {
              sRows.push(foodRow(f, now));
              c.foodKnown.add(f.id);
            }
          }
          const rIds: number[] = [];
          for (const e of this.batchRemoved) {
            const dx = e.x - me.x;
            const dy = e.y - me.y;
            if (dx * dx + dy * dy <= v2) {
              rIds.push(e.id);
              c.foodKnown.delete(e.id);
            }
          }
          if (sRows.length > 0 || rIds.length > 0) {
            c.send(`{"t":"f","s":[${sRows.join(",")}],"r":[${rIds.join(",")}]}`);
          }
        }
      }
      this.batchSpawned = [];
      this.batchRemoved = [];
    }
    if (this.killfeeds.length) {
      // Clients only ever display their own kills, so build per-client
      // messages instead of broadcasting everyone's feed to everyone.
      for (const [pid, c] of this.clients) {
        const mine = this.killfeeds.filter((e) => e.killer !== null && e.killer.id === pid);
        if (mine.length === 0) continue;
        c.send(JSON.stringify({
          t: "kf",
          k: mine.map((e) => [
            e.killer!.id,
            e.killer!.name,
            e.victim.name,
            e.wall ? 1 : 0,
            e.killer!.colorIdx,
            e.victim.colorIdx,
            e.victim.id,
          ]),
        }));
      }
      this.killfeeds = [];
    }
    // Champion announcement: one tiny broadcast per BR round end.
    if (this.pendingChamp) {
      const msg = JSON.stringify({
        t: "champ",
        n: this.pendingChamp.name,
        id: this.pendingChamp.id,
      });
      for (const c of this.clients.values()) c.send(msg);
      this.pendingChamp = null;
    }
    // Real deaths (client deletes + plays death FX). Absence from the
    // interest-filtered `s` broadcast is NOT death, so this is the only
    // thing that may remove a snake client-side.
    if (this.deathEvents.length) {
      const msg = JSON.stringify({
        t: "df",
        d: this.deathEvents.map((e) => [e.victim.id, r1(e.x), r1(e.y)]),
      });
      for (const c of this.clients.values()) c.send(msg);
      this.deathEvents = [];
    }
    if (this.deadStats.size) {
      for (const [pid, st] of this.deadStats) {
        const c = this.clients.get(pid);
        if (c) c.send(JSON.stringify({ t: "dead", st }));
      }
      this.deadStats.clear();
    }
  }

  private broadcastLeaderboard(): void {
    const rows = [...this.players.values()]
      .filter((p) => p.alive)
      .sort((a, b) => b.targetLen - a.targetLen)
      .slice(0, C.LEADERBOARD_SIZE)
      .map((p) => [p.id, p.name, r1(p.targetLen), p.kills, p.colorIdx]);
    const msg = JSON.stringify({ t: "lb", l: rows });
    for (const c of this.clients.values()) c.send(msg);
  }

  /** Nearby food snapshot for a freshly joined client (their spawn view).
      `viewR` must already be clamped by the caller (join path does). Every
      row id is also seeded into `known` so the diff-based keep-sync starts
      from an accurate picture of what this client has. */
  foodSnapshot(p: Player, viewR: number, known: Set<number>): string {
    const r = viewR;
    const v2 = r * r;
    const now = Date.now();
    const rows: string[] = [];
    for (const f of this.food.items.values()) {
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      if (dx * dx + dy * dy <= v2) {
        rows.push(foodRow(f, now));
        known.add(f.id);
      }
    }
    return `{"t":"foods","f":[${rows.join(",")}]}`;
  }
}
