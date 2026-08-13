import {
  BASE_SPEED,
  BOOST_SPEED,
  BOOST_DRAIN_PER_SEC,
  BOOST_MIN_LENGTH,
  BOOST_DROP_INTERVAL_TICKS,
  START_LENGTH, LENGTH_PER_FOOD, PASSIVE_GROW_PER_SEC, MAX_POINTS,
  POINT_SPACING, THICK_MIN, THICK_MAX, THICK_GROW_AT,
  MIN_TURN_SPEED, MAX_TURN_SPEED, TURN_SPEED_FALLOFF,
} from "./config.js";
import { clamp } from "./vec.js";

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
  alive = false;
  kills = 0;
  boosting = false;
  targetLen = START_LENGTH;
  bornAt = 0;
  deathAt = 0;
  respawnAt = 0;
  deathReason: DeathReason | null = null;
  private boostTicks = 0;

  px: number[] = [];
  py: number[] = [];
  /** Grid entries for the collision hash: cells each inserted segment occupies. */
  gridSegs: Array<{ p: Player; i: number; cells: number[] }> = [];
  private totalLen = 0;

  constructor(name: string, colorIdx: number, patternIdx: number, isBot: boolean) {
    this.name = name;
    this.colorIdx = colorIdx;
    this.patternIdx = patternIdx;
    this.isBot = isBot;
  }

  get thick(): number {
    return THICK_MIN + (THICK_MAX - THICK_MIN) * clamp(this.targetLen / THICK_GROW_AT, 0, 1);
  }

  get segmentCount(): number {
    return Math.max(0, this.px.length - 1);
  }

  get lengthUnits(): number {
    return this.targetLen;
  }

  get maxTurnRate(): number {
    const f = clamp(this.targetLen / TURN_SPEED_FALLOFF, 0, 1);
    return MAX_TURN_SPEED - (MAX_TURN_SPEED - MIN_TURN_SPEED) * f;
  }

  spawn(x: number, y: number, angle: number): void {
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.angle = angle;
    this.alive = true;
    this.kills = 0;
    this.boosting = false;
    this.targetLen = START_LENGTH;
    this.bornAt = Date.now();
    this.deathReason = null;
    this.boostTicks = 0;
    this.px = [];
    this.py = [];
    this.gridSegs = [];
    this.totalLen = 0;
    const n = Math.max(4, Math.floor(START_LENGTH / POINT_SPACING));
    const sx = Math.cos(angle);
    const sy = Math.sin(angle);
    for (let i = 0; i < n; i++) {
      this.px.push(x - sx * i * POINT_SPACING);
      this.py.push(y - sy * i * POINT_SPACING);
    }
    this.totalLen = START_LENGTH;
  }

  get aliveTimeMs(): number {
    return this.alive ? Date.now() - this.bornAt : this.deathAt - this.bornAt;
  }

  get speed(): number {
    if (this.boosting && this.targetLen > BOOST_MIN_LENGTH) return BOOST_SPEED;
    return BASE_SPEED;
  }

  headRadius(): number {
    // Matches the circular head radius: thick * 0.58
    return this.thick * 0.58;
  }

  /** Advance the head by dt. Returns moved distance. */
  move(dt: number): number {
    this.targetLen += PASSIVE_GROW_PER_SEC * dt;
    if (this.boosting && this.targetLen > BOOST_MIN_LENGTH) {
      this.targetLen = Math.max(BOOST_MIN_LENGTH, this.targetLen - BOOST_DRAIN_PER_SEC * dt);
    }
    const d = this.speed * dt;
    this.prevX = this.x;
    this.prevY = this.y;
    this.x += Math.cos(this.angle) * d;
    this.y += Math.sin(this.angle) * d;
    const dx = this.x - (this.px[0] ?? this.x);
    const dy = this.y - (this.py[0] ?? this.y);
    const moved = Math.hypot(dx, dy);
    if (moved >= POINT_SPACING) {
      this.px.unshift(this.x);
      this.py.unshift(this.y);
      this.totalLen += moved;
    }
    this.crop();
    return moved;
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

  /** Eat food item. Length + visible tail extension right away. */
  eat(val = 1): void {
    const gained = LENGTH_PER_FOOD * val;
    this.targetLen += gained;
    const n = this.px.length;
    if (n < 2 || this.px.length >= MAX_POINTS - 4) return;
    const tx = this.px[n - 1]! - this.px[n - 2]!;
    const ty = this.py[n - 1]! - this.py[n - 2]!;
    const d = Math.hypot(tx, ty) || 1;
    const ux = tx / d;
    const uy = ty / d;
    let added = 0;
    while (added < gained - 4 && this.px.length < MAX_POINTS) {
      const lastX = this.px[this.px.length - 1]!;
      const lastY = this.py[this.py.length - 1]!;
      this.px.push(lastX + ux * POINT_SPACING);
      this.py.push(lastY + uy * POINT_SPACING);
      this.totalLen += POINT_SPACING;
      added += POINT_SPACING;
    }
  }

  private crop(): void {
    let guard = this.px.length;
    while (this.px.length > 2 && this.totalLen > this.targetLen && guard-- > 0) {
      const n = this.px.length;
      const dx = this.px[n - 2]! - this.px[n - 1]!;
      const dy = this.py[n - 2]! - this.py[n - 1]!;
      this.totalLen -= Math.hypot(dx, dy);
      this.px.pop();
      this.py.pop();
    }
    while (this.px.length > MAX_POINTS) {
      this.px.pop();
      this.py.pop();
    }
  }

  /** Killed by collision or wall. Drops body points as food positions. */
  die(reason: DeathReason): void {
    if (!this.alive) return;
    this.alive = false;
    this.deathReason = reason;
    this.deathAt = Date.now();
  }

  /** Collect dense drop positions along the snake body, head last. Exact mass conservation. */
  dropPositions(): Array<{ x: number; y: number; val: number }> {
    const totalMass = Math.max(15, Math.round(this.targetLen));
    const raw: Array<[number, number]> = [];
    const step = 2;
    for (let i = 0; i < this.px.length; i += step) {
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

