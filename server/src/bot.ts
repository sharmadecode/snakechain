import {
  BASE_SPEED,
  BOT_EYES, BOT_NAMES, NUM_COLORS, NUM_PATTERNS,
  BOT_RESPAWN_MIN_MS, BOT_RESPAWN_MAX_MS,
  POINT_SPACING,
} from "./config.js";
import { Player } from "./player.js";
import { angleDiff, clamp, dist2, normAngle } from "./vec.js";
import { packChain } from "./colors.js";

export interface BotContext {
  alivePlayers: Player[];
  getHalfW(): number;
  getHalfH(): number;
  /** Nearest food within `radius` via the collision grid — never a
      full-map scan (BOT_MAX bots × thousands of items would be heavy
      otherwise). */
  findFood(x: number, y: number, radius: number): { x: number; y: number } | null;
}

const BODY_CLEAR = 185;

export class Bot extends Player {
  private decideAt = 0;
  private targetX = 0;
  private targetY = 0;
  private hasTarget = false;
  private preyId: number | null = null;
  private committing = false;

  // Per-bot personality, rolled once at spawn so the field feels alive:
  // aggressive bots hunt exposed heads and cut people off, cautious ones
  // keep a bigger bubble and mostly graze.
  private readonly aggression = 0.3 + Math.random() * 0.6;
  private readonly caution = 0.85 + Math.random() * 0.5;

  constructor() {
    const name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]!;
    const c0 = Math.floor(Math.random() * NUM_COLORS);
    const c1 = (c0 + 1 + Math.floor(Math.random() * (NUM_COLORS - 1))) % NUM_COLORS;
    const c2 = (c1 + 1 + Math.floor(Math.random() * (NUM_COLORS - 1))) % NUM_COLORS;
    const c3 = (c2 + 1 + Math.floor(Math.random() * (NUM_COLORS - 1))) % NUM_COLORS;
    const c4 = (c3 + 1 + Math.floor(Math.random() * (NUM_COLORS - 1))) % NUM_COLORS;
    // Canonical count-nibble format (see colors.ts) — the client's
    // unpackColors reads nibble 0 as the chain length, so packing raw
    // nibbles here would corrupt most bot skins.
    const packed = packChain([c0, c1, c2, c3, c4]);
    super(name, packed, Math.floor(Math.random() * NUM_PATTERNS), true);
  }

  scheduleRespawn(): void {
    this.respawnAt =
      Date.now() + BOT_RESPAWN_MIN_MS + Math.random() * (BOT_RESPAWN_MAX_MS - BOT_RESPAWN_MIN_MS);
  }

  update(dt: number, ctx: BotContext): void {
    if (!this.alive) return;
    const now = Date.now();

    if (now >= this.decideAt) {
      this.decideAt = now + 140;
      this.pickTarget(ctx);
    }

    const desired = Math.atan2(this.targetY - this.y, this.targetX - this.x);
    const diff = angleDiff(this.angle, desired);
    const turnRate = this.maxTurnRate;
    this.angle = normAngle(this.angle + clamp(diff, -turnRate * dt, turnRate * dt));
  }

  private pickTarget(ctx: BotContext): void {
    const halfW = ctx.getHalfW();
    const halfH = ctx.getHalfH();

    // 1) Wall danger: circular boundary avoidance
    if (this.nearWallDanger(halfW)) {
      this.boosting = false;
      return;
    }

    // 2) Threats: bodies and heads of snakes that can kill us.
    const threat = this.closestThreat(ctx);
    if (threat) {
      this.preyId = null;
      this.boosting = false;
      this.evade(threat);
      return;
    }

    // 3) Hunt: cut off an exposed head when we're clearly bigger.
    if (this.targetLen >= 55 && this.aggression > Math.random()) {
      const prey = this.pickPrey(ctx);
      if (prey) {
        this.preyId = prey.id;
        this.committing = dist2(this.x, this.y, prey.x, prey.y) < 240 * 240;
        // Tactical boost when cutting off prey
        this.boosting = this.committing && this.targetLen > 110 && Math.random() < 0.7;
        const p = this.interceptPoint(prey);
        if (p && this.pathSafe(p.x, p.y, prey)) {
          this.targetX = p.x;
          this.targetY = p.y;
          this.hasTarget = true;
          return;
        }
      }
    }
    this.preyId = null;
    this.committing = false;
    this.boosting = false;

    // 4) Graze: nearest food in the eye radius (spatial query, no full scan)
    const eye = this.targetLen < 60 ? BOT_EYES + 100 : BOT_EYES;
    const f = ctx.findFood(this.x, this.y, eye);
    this.hasTarget = false;
    if (f) {
      this.targetX = f.x;
      this.targetY = f.y;
      this.hasTarget = true;
    }

    // 5) Wander: prefer orbiting towards the center so bots stay active
    if (!this.hasTarget) {
      const distFromCenter = Math.hypot(this.x, this.y);
      let a = Math.random() * Math.PI * 2;
      if (distFromCenter > halfW * 0.6) {
        // Steer back towards center
        a = Math.atan2(-this.y, -this.x) + (Math.random() - 0.5) * 1.2;
      }
      const r = 250 + Math.random() * 400;
      this.targetX = this.x + Math.cos(a) * r;
      this.targetY = this.y + Math.sin(a) * r;
      this.hasTarget = true;
    }
  }

  /** True when the bot is inside the circular border band and heading towards the wall. */
  private nearWallDanger(radius: number): boolean {
    const d = Math.hypot(this.x, this.y);
    if (d < radius - 180) return false;

    const angleToCenter = Math.atan2(-this.y, -this.x);
    const outwardAngle = Math.atan2(this.y, this.x);
    const headingDiff = Math.abs(angleDiff(this.angle, outwardAngle));

    // Heading outward or dangerously close to the wall
    if (headingDiff < Math.PI / 2 + 0.3 || d > radius - 70) {
      // Steer inward and tangentially away from boundary
      const tangent1 = outwardAngle + Math.PI / 2 + 0.4;
      const tangent2 = outwardAngle - Math.PI / 2 - 0.4;
      const diff1 = Math.abs(angleDiff(this.angle, tangent1));
      const diff2 = Math.abs(angleDiff(this.angle, tangent2));
      const chosen = diff1 < diff2 ? tangent1 : tangent2;

      this.targetX = this.x + Math.cos(chosen) * 350;
      this.targetY = this.y + Math.sin(chosen) * 350;
      this.hasTarget = true;
      return true;
    }
    return false;
  }

  /** Closest lethal contact point: bodies of every snake plus the
      predicted position of heads that are bigger than us. The current
      prey only counts within a small radius so the hunt can finish. */
  private closestThreat(ctx: BotContext): { x: number; y: number } | null {
    const clear = BODY_CLEAR * this.caution;
    const preyClear = 95;
    let bx = this.x;
    let by = this.y;
    let bd = clear * clear;
    for (const p of ctx.alivePlayers) {
      if (p === this || !p.alive) continue;
      const radius = p.id === this.preyId ? preyClear : clear;
      // Bounding-circle early-out: every body point lies within
      // px.length * POINT_SPACING of the head, and the predicted-head probe
      // below leads by at most 300*caution units. If neither bubble can
      // reach us, skip the whole walk — identical decisions, far fewer
      // distance checks in crowded arenas.
      const hd2 = dist2(this.x, this.y, p.x, p.y);
      const bodyReach = radius + p.px.length * POINT_SPACING;
      const canPredictHead =
        p.id !== this.preyId && p.targetLen > this.targetLen * 1.2;
      if (
        hd2 > bodyReach * bodyReach &&
        !(canPredictHead && hd2 <= (300 * this.caution + p.px.length * POINT_SPACING) ** 2)
      ) {
        continue;
      }
      const rr = radius * radius;
      const stride = p.px.length > 300 ? 6 : 3;
      for (let i = 0; i < p.px.length; i += stride) {
        const d2 = dist2(this.x, this.y, p.px[i]!, p.py[i]!);
        if (d2 < rr && d2 < bd) {
          bd = d2;
          bx = p.px[i]!;
          by = p.py[i]!;
        }
      }
      // Bigger heads: predict where they will be and avoid that too.
      if (p.id !== this.preyId && p.targetLen > this.targetLen * 1.2) {
        const vx = p.x - p.prevX;
        const vy = p.y - p.prevY;
        const headD2 = dist2(this.x, this.y, p.x + vx * 0.35, p.y + vy * 0.35);
        const headRange = 300 * this.caution;
        if (headD2 < headRange * headRange && headD2 < bd) {
          bd = headD2;
          bx = p.x + vx * 0.35;
          by = p.y + vy * 0.35;
        }
      }
    }
    return bd < clear * clear ? { x: bx, y: by } : null;
  }

  /** Hard turn away from a close threat, or a momentum-preserving veer. */
  private evade(threat: { x: number; y: number }): void {
    const away = Math.atan2(this.y - threat.y, this.x - threat.x);
    const ahead = Math.abs(angleDiff(this.angle, Math.atan2(threat.y - this.y, threat.x - this.x)));
    if (ahead > Math.PI / 2) {
      this.targetX = this.x + Math.cos(away) * 400;
      this.targetY = this.y + Math.sin(away) * 400;
    } else {
      const veer = this.angle + clamp(angleDiff(away, this.angle) * 0.5, -1.2, 1.2);
      this.targetX = this.x + Math.cos(veer) * 400;
      this.targetY = this.y + Math.sin(veer) * 400;
    }
    this.hasTarget = true;
  }

  /** A smaller snake whose head is exposed and reachable. */
  private pickPrey(ctx: BotContext): Player | null {
    const range = 420 + this.aggression * 220;
    let best: Player | null = null;
    let bestD = range * range;
    for (const p of ctx.alivePlayers) {
      if (p === this || !p.alive) continue;
      if (p.targetLen > this.targetLen * 1.15) continue;
      const d2 = dist2(this.x, this.y, p.x, p.y);
      if (d2 < bestD) {
        bestD = d2;
        best = p;
      }
    }
    return best;
  }

  /** Phase 1 (approach): lead the prey's head by time-to-contact so we
      arrive where it will be. Phase 2 (commit, <220px): run parallel just
      ahead of the prey's head so our body ends up stretched across its
      path — the prey's head then plows into us and it dies. */
  private interceptPoint(prey: Player): { x: number; y: number } | null {
    const vx = prey.x - prey.prevX;
    const vy = prey.y - prey.prevY;
    const v = Math.hypot(vx, vy);
    if (v < 1) return null;
    if (this.committing) {
      return { x: prey.x + (vx / v) * 55, y: prey.y + (vy / v) * 55 };
    }
    const d = Math.sqrt(dist2(this.x, this.y, prey.x, prey.y));
    const lead = clamp((d / BASE_SPEED) * 0.9 + 0.25, 0, 1.1);
    return { x: prey.x + (vx / v) * v * lead, y: prey.y + (vy / v) * v * lead };
  }

  /** The straight line to the intercept point must stay clear of the
      prey's body, or the bot would suicide on it. */
  private pathSafe(tx: number, ty: number, prey: Player): boolean {
    const dx = tx - this.x;
    const dy = ty - this.y;
    const stride = prey.px.length > 300 ? 6 : 3;
    for (let i = 1; i <= 5; i++) {
      const x = this.x + dx * (i / 5);
      const y = this.y + dy * (i / 5);
      for (let j = 0; j < prey.px.length; j += stride) {
        if (dist2(x, y, prey.px[j]!, prey.py[j]!) < 90 * 90) return false;
      }
    }
    return true;
  }
}
