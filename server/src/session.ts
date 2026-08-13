import { FoodManager, FoodItem } from "./food.js";
import { Player } from "./player.js";
import { Bot, BotContext } from "./bot.js";
import { Grid } from "./grid.js";
import * as C from "./config.js";
import { dist2, pointSegDist2 } from "./vec.js";
import fs from "node:fs";

const fsSyncWrite = (line: string): void => {
  fs.writeSync(1, line);
};

export interface ClientHandle {
  send(data: string): void;
  /** Client-reported viewport radius (world units), clamped server-side. */
  viewR: number;
  /** Players whose authoritative body has already been sent to this client
      (reset on re-join; re-entry after leaving view re-sends immediately). */
  bodyKnown: Set<number>;
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
  wall: boolean;
}

interface SegEntry {
  p: Player;
  i: number;
  cells: number[];
}

function r1(v: number): number {
  return Math.round(v * 10) / 10;
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
  /** Real deaths queued for the per-tick `df` broadcast. */
  private deathEvents: Array<{ victim: Player; x: number; y: number }> = [];
  private deadStats = new Map<number, DeadStats>();
  private lastLbAt = 0;
  private lastFoodSyncAt = 0;
  /** Last targetLen at which each player's body was sampled for clients
      (growth > BODY_GROWTH_RESEND forces an immediate refresh). */
  private bodyLenAt = new Map<number, number>();
  private tickNo = 0;
  private perfAcc = 0;
  private perfSamples = 0;
  private lastPerfLog = 0;
  private accMs = 0;
  private lastTickAt: number | null = null;
  private ctx: BotContext;

  constructor() {
    this.id = `s${sessionSeq++}`;
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
    if (b.alive) this.killPlayer(b, null, false, true);
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
    p.spawn(pos[0], pos[1], Math.random() * Math.PI * 2);
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
   * This guarantees 100% accurate, drift-free, pixel-perfect collision detection
   * along the neck and entire body.
   */
  private updateSegsInGrid(p: Player): void {
    this.removeSegsFromGrid(p);
    const n = p.px.length;
    if (n < 1) return;
    const keep: SegEntry[] = [];

    // 1. Neck segment (from head to first body point)
    const neckCells = this.grid.segmentCells(p.x, p.y, p.px[0]!, p.py[0]!);
    const neckEntry: SegEntry = { p, i: -1, cells: neckCells };
    this.grid.insertInto(neckCells, neckEntry);
    keep.push(neckEntry);

    // 2. Body segments along px/py
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
    const nearBody = (x: number, y: number): boolean => {
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const isHuman = !p.isBot;
        const headClear = isHuman || isHumanSpawner ? 420 : 260;
        const bodyClear = isHuman || isHumanSpawner ? 300 : 170;
        if (dist2(x, y, p.x, p.y) < headClear * headClear) return true;
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
    // Fallback: farthest spot from heads AND bodies (stride 4). Only accept
    // positions with at least the spawn clearance — if none exists the
    // caller retries later instead of force-spawning onto a body.
    const minClear = isHumanSpawner ? 300 : 170;
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
        if (p.x * p.x + p.y * p.y > this.halfW * this.halfW) {
          this.killPlayer(p, null, true, false);
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
          } else if (item.p !== p) {
            const seg = item;
            const x1 = seg.i === -1 ? seg.p.x : seg.p.px[seg.i]!;
            const y1 = seg.i === -1 ? seg.p.y : seg.p.py[seg.i]!;
            const x2 = seg.i === -1 ? seg.p.px[0]! : seg.p.px[seg.i + 1]!;
            const y2 = seg.i === -1 ? seg.p.py[0]! : seg.p.py[seg.i + 1]!;
            const d2 = pointSegDist2(p.x, p.y, x1, y1, x2, y2);
            // Body radius thick*0.5 matches the rendered box width.
            // If the head's front edge touches the opponent's body segment:
            if (d2 < (r + seg.p.thick * 0.48) ** 2) {
              const q = seg.p;
              const headTouch =
                seg.i <= 0 &&
                dist2(p.x, p.y, q.x, q.y) < (p.headRadius() + q.headRadius()) ** 2;
              if (!headTouch) this.killPlayer(p, q, false, false);
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
          this.killPlayer(loser, winner, false, false);
        }
      }

      const targetFood = Math.min(C.FOOD_CAP, Math.max(1800, this.aliveCount * C.FOOD_PER_ACTOR));
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
    } catch (err) {
      console.error("[session] tick error", err);
    }
    const dt = performance.now() - t0;
    this.perfAcc += dt;
    this.perfSamples++;
    if (Date.now() - this.lastPerfLog > 10_000 && process.env.STRESS === "1") {
      this.lastPerfLog = Date.now();
      const line =
        `[perf] ${this.id}: ${(this.perfAcc / this.perfSamples).toFixed(2)}ms/tick, ` +
        `${this.players.size} players, ${this.aliveCount} alive, ${this.food.items.size} food, ${r1(this.halfW)} half\n`;
      try {
        fsSyncWrite(line);
      } catch {
        /* noop */
      }
      this.perfAcc = 0;
      this.perfSamples = 0;
    }
  }

  /** Periodic authoritative food re-sync per client: every FOOD_SYNC_MS
      each client's view is replaced with exactly the food that exists near
      them, wiping out ghosts from filtered events. */
  private foodKeepSync(): void {
    if (Date.now() - this.lastFoodSyncAt < C.FOOD_SYNC_MS) return;
    this.lastFoodSyncAt = Date.now();
    const now = Date.now();
    for (const [pid, c] of this.clients) {
      const me = this.players.get(pid);
      if (!me) continue;
      const r = Math.max(C.VIEW_HALF, c.viewR);
      const v2 = r * r;
      const rows: string[] = [];
      this.grid.forEachNear(me.x, me.y, r, (item) => {
        if (!(item instanceof FoodItem)) return;
        const dx = item.x - me.x;
        const dy = item.y - me.y;
        if (dx * dx + dy * dy <= v2) {
          const isDrop = item.isDeathDrop && (now - item.dropAt < 4000) ? 1 : 0;
          rows.push(`[${item.id},${r1(item.x)},${r1(item.y)},${item.colorIdx},${isDrop}]`);
        }
      });
      c.send(`{"t":"f","k":[${rows.join(",")}]}`);
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

  private killPlayer(p: Player, killer: Player | null, wall: boolean, silent: boolean): void {
    if (!p.alive) return;
    p.die(wall ? "wall" : "crash");
    if (killer && killer.alive && !silent) killer.kills++;
    if (!silent) {
      for (const drop of p.dropPositions()) this.food.addDeathDrop(drop.x, drop.y, p.colorIdx, drop.val);
      this.killfeeds.push({ killer, victim: p, wall });
      this.deathEvents.push({ victim: p, x: p.x, y: p.y });
    }
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
        wall,
      });
    }
    if (p.isBot) (p as Bot).scheduleRespawn();
  }

  private broadcastState(): void {
    // Serialize each alive player's row once per tick, then hand each
    // client only the rows inside its view. Names are SAFE_NAME-validated
    // (no quotes/backslashes), so rows can be built as raw strings.
    const rowBuf = new Map<number, string>();
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      rowBuf.set(
        p.id,
        `[${p.id},${r1(p.x)},${r1(p.y)},${r1(p.angle)},${r1(p.targetLen)},${r1(p.thick)},` +
          `${p.colorIdx},${p.patternIdx},${p.isBot ? 1 : 0},0,${p.kills},"${p.name}"]`,
      );
    }
    const base = `{"t":"s","tk":${this.tickNo},"w":[${r1(this.halfW)},${r1(this.halfH)}],"p":[`;
    const bodyCadence = this.tickNo % 3 === 0; // ~10 TPS authoritative refresh
    for (const [pid, c] of this.clients) {
      const me = this.players.get(pid);
      if (!me) continue;
      const r = Math.max(C.VIEW_HALF, c.viewR);
      const v2 = r * r;
      let rows = "";
      let first = true;
      const bodyRows: string[] = [];
      for (const [id, row] of rowBuf) {
        const q = this.players.get(id)!;
        // Sync a player if its head OR any coarse body point is within the
        // view radius: a long body can sweep across the client's screen even
        // when the head is far away. Without this the body would pop in and
        // out invisibly (and kill heads with no visible body to dodge).
        let dx = q.x - me.x;
        let dy = q.y - me.y;
        let inView = dx * dx + dy * dy <= v2;
        if (!inView) {
          for (let i = 0; i < q.px.length; i += 8) {
            dx = q.px[i]! - me.x;
            dy = q.py[i]! - me.y;
            if (dx * dx + dy * dy <= v2) {
              inView = true;
              break;
            }
          }
        }
        if (inView) {
          if (!first) rows += ",";
          rows += row;
          first = false;
          // Authoritative body: send on first entry into view (before a
          // newly relevant snake can kill this client), on the ~10 TPS
          // cadence while visible, and immediately on significant growth.
          const known = c.bodyKnown.has(id);
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

  /** Sample a player's path head->tail every BODY_SAMPLE_DIST units,
      capped at BODY_SAMPLE_CAP points. px[0] is the head. Returns null when
      the path is too short to yield a single sample (fresh spawns) — an
      empty row would emit `[id,x,y,]` and break JSON parsing. */
  private bodyRow(p: Player): string | null {
    const pts: number[] = [];
    let lastX = p.x;
    let lastY = p.y;
    let acc = 0;
    let emitted = 1;
    for (let i = 0; i < p.px.length && emitted < C.BODY_SAMPLE_CAP; i++) {
      const dx = p.px[i]! - lastX;
      const dy = p.py[i]! - lastY;
      acc += Math.hypot(dx, dy);
      if (acc >= C.BODY_SAMPLE_DIST) {
        pts.push(r1(p.px[i]!), r1(p.py[i]!));
        emitted++;
        acc = 0;
        lastX = p.px[i]!;
        lastY = p.py[i]!;
      }
    }
    if (pts.length === 0) return null;
    return `[${p.id},${r1(p.x)},${r1(p.y)},${pts.join(",")}]`;
  }

  private flushEvents(): void {
    const { s, r, sItems, rItems } = this.food.flushEvents();

    // Differential grid sync: food spawned this tick (fill + death drops)
    // enters the collision grid, eaten food leaves it.
    for (const f of sItems) this.grid.insert(f.x, f.y, f);
    for (const f of rItems) this.grid.remove(f.x, f.y, f);

    if (s.length > 0 || r.length > 0) {
      const now = Date.now();
      for (const [pid, c] of this.clients) {
        const me = this.players.get(pid);
        if (!me) continue;
        const vr = Math.max(C.VIEW_HALF, c.viewR);
        const v2 = vr * vr;
        const sRows: string[] = [];
        for (const f of sItems) {
          const dx = f.x - me.x;
          const dy = f.y - me.y;
          if (dx * dx + dy * dy <= v2) {
            const isDrop = f.isDeathDrop && (now - f.dropAt < 4000) ? 1 : 0;
            sRows.push(`[${f.id},${r1(f.x)},${r1(f.y)},${f.colorIdx},${isDrop}]`);
          }
        }
        const rIds: number[] = [];
        for (let i = 0; i < r.length; i++) {
          const f = rItems[i];
          if (f) {
            const dx = f.x - me.x;
            const dy = f.y - me.y;
            if (dx * dx + dy * dy <= v2) rIds.push(r[i]!);
          }
        }
        if (sRows.length > 0 || rIds.length > 0) {
          c.send(`{"t":"f","s":[${sRows.join(",")}],"r":[${rIds.join(",")}]}`);
        }
      }
    }
    if (this.killfeeds.length) {
      const msg = JSON.stringify({
        t: "kf",
        k: this.killfeeds.map((e) => [
          e.killer ? e.killer.id : -1,
          e.killer ? e.killer.name : null,
          e.victim.name,
          e.wall ? 1 : 0,
          e.killer ? e.killer.colorIdx : -1,
          e.victim.colorIdx,
          e.victim.id,
        ]),
      });
      for (const c of this.clients.values()) c.send(msg);
      this.killfeeds = [];
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

  /** Nearby food snapshot for a freshly joined client (their spawn view). */
  foodSnapshot(p: Player, viewR: number): string {
    const r = Math.max(C.VIEW_HALF, viewR);
    const v2 = r * r;
    const now = Date.now();
    const rows: string[] = [];
    for (const f of this.food.items.values()) {
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      if (dx * dx + dy * dy <= v2) {
        const isDrop = f.isDeathDrop && (now - f.dropAt < 4000) ? 1 : 0;
        rows.push(`[${f.id},${r1(f.x)},${r1(f.y)},${f.colorIdx},${isDrop}]`);
      }
    }
    return `{"t":"foods","f":[${rows.join(",")}]}`;
  }
}
