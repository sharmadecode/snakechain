import {
  BASE_SPEED,
  BOOST_SPEED,
  BOOST_DRAIN_PER_SEC,
  BOOST_MIN_LENGTH,
  BOOST_DROP_INTERVAL_TICKS,
  START_LENGTH, BOT_MAX_POINTS, LENGTH_PER_FOOD, PASSIVE_GROW_PER_SEC, MAX_POINTS,
  GROWTH_RATE, SPAWN_PROTECT_MS,
  POINT_SPACING, THICK_MIN, THICK_MAX, THICK_GROW_AT,
  MIN_CHAIN_SEGS, CHAIN_GROW_PER_TICK,
  MIN_TURN_SPEED, MAX_TURN_SPEED, TURN_SPEED_FALLOFF,
} from "./config.js";
import { angleDiff, clamp, normAngle } from "./vec.js";

let nextPlayerId = 1;

export type DeathReason = "crash" | "wall";

export class Player {
  readonly id = nextPlayerId++;
  readonly isBot: boolean;
  name: string;
  colorIdx: number;
  patternIdx: number;

  x = 0;
  y = 0;
  prevX = 0;
  prevY = 0;
  angle = 0;
  /** Desired heading from client input (humans only). move() clamps the
      actual turn toward it at maxTurnRate so clients cannot teleport-turn.
      null = steer straight (bots manage their own angle in Bot.update). */
  targetAngle: number | null = null;
  alive = false;
  kills = 0;
  boosting = false;
  targetLen = START_LENGTH;
  bornAt = 0;
  deathAt = 0;
  respawnAt = 0;
  /** Fresh-spawn invulnerability window (server-authoritative). Cancels on
      boost. Rides the state-broadcast row (slot 9) to clients as a shimmer. */
  spawnProtectUntil = 0;
  deathReason: DeathReason | null = null;
  private boostTicks = 0;

  px: number[] = [];
  py: number[] = [];
  // Follow-the-leader chain: px[0]/py[0] IS the head; every other entry is a
  // physical body segment kept within POINT_SPACING of its predecessor (see
  // PHASES.md §1). Loops compact and corners cut — no steering history.

  /** Grid entries for the collision hash: cells each inserted segment occupies. */
  gridSegs: Array<{ p: Player; i: number; cells: number[] }> = [];

  constructor(name: string, colorIdx: number, patternIdx: number, isBot: boolean) {
    this.name = name;
    this.colorIdx = colorIdx;
    this.patternIdx = patternIdx;
    this.isBot = isBot;
  }

  get thick(): number {
    return THICK_MIN + (THICK_MAX - THICK_MIN) * clamp(this.targetLen / THICK_GROW_AT, 0, 1);
  }

  get maxTurnRate(): number {
    const f = clamp(this.targetLen / TURN_SPEED_FALLOFF, 0, 1);
    return MAX_TURN_SPEED - (MAX_TURN_SPEED - MIN_TURN_SPEED) * f;
  }

  /** `startLen` lets bots spawn at BOT_START_LENGTH while humans keep the
      classic START_LENGTH. */
  spawn(x: number, y: number, angle: number, startLen: number = START_LENGTH): void {
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.angle = angle;
    this.targetAngle = null; // drop stale input from a previous life
    this.alive = true;
    this.kills = 0;
    this.boosting = false;
    this.targetLen = startLen;
    this.bornAt = Date.now();
    this.deathReason = null;
    this.boostTicks = 0;
    this.spawnProtectUntil = Date.now() + SPAWN_PROTECT_MS;
    this.px = [];
    this.py = [];
    this.gridSegs = [];
    const n = Math.min(
      MAX_POINTS,
      Math.max(MIN_CHAIN_SEGS, Math.round(startLen / POINT_SPACING)),
    );
    const sx = Math.cos(angle);
    const sy = Math.sin(angle);
    for (let i = 0; i < n; i++) {
      this.px.push(x - sx * i * POINT_SPACING);
      this.py.push(y - sy * i * POINT_SPACING);
    }
  }

  get aliveTimeMs(): number {
    return this.alive ? Date.now() - this.bornAt : this.deathAt - this.bornAt;
  }

  get speed(): number {
    if (this.boosting && this.targetLen > BOOST_MIN_LENGTH) return BOOST_SPEED;
    return BASE_SPEED;
  }

  /** Server-side truth: clients only ever receive this as a display flag. */
  isProtected(): boolean {
    return this.alive && Date.now() < this.spawnProtectUntil;
  }

  headRadius(): number {
    // Matches the circular head radius: thick * 0.58
    return this.thick * 0.58;
  }

  /** Advance the head by dt and propagate the chain. Returns moved distance. */
  move(dt: number): number {
    if (this.targetAngle !== null) {
      const diff = angleDiff(this.angle, this.targetAngle);
      const max = this.maxTurnRate * dt;
      this.angle = normAngle(this.angle + clamp(diff, -max, max));
    }
    this.targetLen += PASSIVE_GROW_PER_SEC * dt;
    if (this.boosting) {
      // Boosting cancels the fresh-spawn shield instantly — no invulnerable
      // rushing across the arena.
      this.spawnProtectUntil = 0;
    }
    if (this.boosting && this.targetLen > BOOST_MIN_LENGTH) {
      this.targetLen = Math.max(BOOST_MIN_LENGTH, this.targetLen - BOOST_DRAIN_PER_SEC * dt);
    }
    const d = this.speed * dt;
    this.prevX = this.x;
    this.prevY = this.y;
    this.x += Math.cos(this.angle) * d;
    this.y += Math.sin(this.angle) * d;

    // Head IS segment 0.
    this.px[0] = this.x;
    this.py[0] = this.y;

    // Follow-the-leader: pull each trailing segment onto the ring of radius
    // POINT_SPACING around its predecessor whenever it trails farther than
    // that. Segments CLOSER than spacing (inner rail of tight turns) are left
    // alone — that asymmetry is what makes loops compact and dissolve instead
    // of persisting as steering history. Pure function of positions, so the
    // client mirror in state.ts stays byte-identical with authority.
    const spacing = POINT_SPACING;
    const spacingSq = spacing * spacing;
    const n = this.px.length;
    for (let i = 1; i < n; i++) {
      const ax = this.px[i - 1]!;
      const ay = this.py[i - 1]!;
      const dx = this.px[i]! - ax;
      const dy = this.py[i]! - ay;
      // Squared-distance gate avoids Math.hypot (slow in V8) on the hottest
      // loop in the simulation; sqrt runs only when a snap actually happens.
      // MUST stay identical to the client mirror in web/src/state.ts.
      const d2 = dx * dx + dy * dy;
      if (d2 > spacingSq) {
        const k = spacing / Math.sqrt(d2);
        this.px[i] = ax + dx * k;
        this.py[i] = ay + dy * k;
      }
    }
    this.adjustChainLength();
    return d;
  }

  /** Grow/shrink the segment count toward targetLen at bounded rates so
      length changes read organically (a +300 windfall animates over ~10
      ticks; boost drain sheds ~0.6 segments/sec). Duplicated tail segments
      unfurl naturally as their predecessor pulls away. */
  private adjustChainLength(): void {
    const desired = Math.min(
      MAX_POINTS,
      Math.max(MIN_CHAIN_SEGS, Math.round(this.targetLen / POINT_SPACING)),
    );
    let n = this.px.length;
    let grown = 0;
    while (n < desired && grown < CHAIN_GROW_PER_TICK) {
      this.px.push(this.px[n - 1]!);
      this.py.push(this.py[n - 1]!);
      n++;
      grown++;
    }
    while (n > desired && n > MIN_CHAIN_SEGS) {
      this.px.pop();
      this.py.pop();
      n--;
    }
  }

  /** Check if boosting snake should drop mass pellet at its tail tip */
  checkBoostDrop(): [number, number] | null {
    if (!this.boosting || this.targetLen <= BOOST_MIN_LENGTH || this.px.length < 3) {
      this.boostTicks = 0;
      return null;
    }
    this.boostTicks++;
    if (this.boostTicks >= BOOST_DROP_INTERVAL_TICKS) {
      this.boostTicks = 0;
      const tailIdx = this.px.length - 1;
      const tx = this.px[tailIdx]!;
      const ty = this.py[tailIdx]!;
      // Small random spread so trailing pellets don't overlap completely
      const spread = (Math.random() - 0.5) * 8;
      return [tx + spread, ty + spread];
    }
    return null;
  }

  /** Eat food item. Raises targetLen; adjustChainLength() grows the visible
      body organically over the next ticks. GROWTH_RATE scales ALL food gains
      (global slow-down dial). Bots are hard-capped at BOT_MAX_POINTS —
      surplus mass stays in the world as claimable loot. Everyone is capped
      at MAX_POINTS × spacing so the leaderboard can never show a length the
      streamed body can't represent. */
  eat(val = 1): void {
    // Eating breaks the fresh-spawn shield — “shield breaks on action”.
    this.spawnProtectUntil = 0;
    const cap = this.isBot ? BOT_MAX_POINTS : Infinity;
    const gained = Math.min(
      LENGTH_PER_FOOD * val * GROWTH_RATE,
      Math.max(0, cap - this.targetLen),
    );
    this.targetLen = Math.min(MAX_POINTS * POINT_SPACING, this.targetLen + gained);
  }

  /** Killed by collision or wall. Drops body points as food positions. */
  die(reason: DeathReason): void {
    if (!this.alive) return;
    this.alive = false;
    this.deathReason = reason;
    this.deathAt = Date.now();
  }

  /** Collect dense drop positions along the snake body, head last.
      Approximate mass conservation: ±rounding, a 15-length floor and a
      160-pellet cap mean total pellet value ≈ targetLen but not exactly. */
  dropPositions(): Array<{ x: number; y: number; val: number }> {
    const totalMass = Math.max(15, Math.round(this.targetLen));
    const raw: Array<[number, number]> = [];
    // Start at i=1 — the true head position is appended explicitly below.
    const step = 2;
    for (let i = 1; i < this.px.length; i += step) {
      const jx = (Math.random() - 0.5) * 8;
      const jy = (Math.random() - 0.5) * 8;
      raw.push([this.px[i]! + jx, this.py[i]! + jy]);
      if (raw.length >= 160) break;
    }
    raw.push([this.x, this.y]);
    const numPellets = Math.max(1, raw.length);
    const valPerPellet = Math.max(1, Math.round(totalMass / numPellets));
    return raw.map(([x, y]) => ({ x, y, val: valPerPellet }));
  }
}

