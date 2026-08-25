export interface PlayerState {
  id: number;
  name: string;
  colorIdx: number;
  patternIdx: number;
  isBot: boolean;
  kills: number;
  /** Fresh-spawn shield (server flag, broadcast row slot 9). Display only. */
  shield: boolean;
  /** Render-side boost state with hysteresis (inferred from velocity EMA for
      remotes; main.ts overrides with exact input state for SELF). Drives the
      boost glow. Purely cosmetic — server collision never reads this. */
  boostVis: boolean;
  tx: number;
  ty: number;
  ta: number;
  tlen: number;
  thick: number;
  x: number;
  y: number;
  a: number;
  len: number;
  px: number[];
  py: number[];
  total: number;
  vx: number;
  vy: number;
  rvx: number;
  rvy: number;
  lastRowT: number;
  rowHist: Array<{ x: number; y: number; t: number }>;
  /** Authoritative sampled body from the server (flat [x,y,...], head-first
      order but WITHOUT the head pair), or null when not yet received. */
  body: number[] | null;
}

export interface DeadStats {
  kills: number;
  timeMs: number;
  maxLen: number;
  rank: number;
  killerName?: string | null;
  killerId?: number;
  wall?: boolean;
}

const SPACING = 10;
/** Mirrors server MAX_POINTS (config.ts). Kept as a named constant so the
    two can never silently drift — see server/src/config.ts rationale. */
const MAX_LOCAL_POINTS = 900;

export class GameState {
  myId = 0;
  halfW = 900;
  halfH = 900;
  tickRate = 30;
  /** Turn model echoed by the server `hi` handshake:
      [MAX_TURN_SPEED, MIN_TURN_SPEED, TURN_SPEED_FALLOFF]. Falls back to the
      shipped defaults so an old server can't break prediction. */
  turn: number[] = [6.0, 2.8, 800];
  players = new Map<number, PlayerState>();
  /** id -> [x, y, colorIdx, dropSpawnTimeMs, golden?] */
  food = new Map<number, [number, number, number, number, number?]>();
  leaderboard: Array<[number, string, number, number, number]> = [];
  ping = -1;
  /** Spectate-on-death: while dead with a known killer, the camera follows
      this player id instead of freezing. Cleared on respawn/lobby/reset. */
  spectateId = 0;
  dead: DeadStats | null = null;
  alive = false;
  /** Renderer-consumed effect queues: [x, y, colorIdx, thick] for bursts. */
  deathFx: Array<[number, number, number, number]> = [];
  /** [x, y, colorIdx] for eat sparkles. */
  eatenFx: Array<[number, number, number]> = [];

  /** Drop everything from the previous match so the client is ready for a
      fresh lobby session. */
  reset(): void {
    this.myId = 0;
    this.halfW = 900;
    this.halfH = 900;
    this.tickRate = 30;
    this.players.clear();
    this.food.clear();
    this.leaderboard = [];
    this.ping = -1;
    this.spectateId = 0;
    this.dead = null;
    this.alive = false;
    // Leftover burst/sparkle queues must not replay into a fresh session.
    this.deathFx.length = 0;
    this.eatenFx.length = 0;
  }

  applyState(msg: Record<string, unknown>): void {
    const w = msg.w as number[];
    this.halfW = w[0] ?? 900;
    this.halfH = w[1] ?? 900;
    const rows = (msg.p as unknown[]) ?? [];
    const now = performance.now();
    for (const r of rows) {
      const row = r as unknown[];
      const id = row[0] as number;
      const pl = this.players.get(id);
      const tx = row[1] as number;
      const ty = row[2] as number;
      const ta = row[3] as number;
      const tlen = row[4] as number;
      const thick = row[5] as number;
      if (pl) {
        // Respawn jump: the same id reappeared at a new spawn point
        // (bots respawn with the same id). Re-init instead of lerping a
        // teleport across the map; the server `b` body message then fills
        // in the authoritative tail within ~100 ms.
        if (Math.hypot(tx - pl.x, ty - pl.y) > 800) {
          this.players.set(id, this.makePlayer(row));
          continue;
        }
        // Windowed velocity estimate: average displacement over the past
        // ~100ms instead of the last row pair. Rows arrive at irregular
        // wall-clock intervals (timer coalescing, catch-up steps), so a
        // single dx/dt sample oscillates between 1-step and 2-step
        // displacements and makes the extrapolation lead jitter.
        const hist = pl.rowHist;
        hist.push({ x: tx, y: ty, t: now });
        while (hist.length > 1 && now - hist[0]!.t > 300) hist.shift();
        let nvx = 0;
        let nvy = 0;
        let base = -1;
        for (let i = hist.length - 1; i >= 0; i--) {
          if (now - hist[i]!.t >= 150) {
            base = i;
            break;
          }
        }
        if (base < 0) base = 0;
        if (base >= 0) {
          const e = hist[base]!;
          const dtS = (now - e.t) / 1000;
          const dx = tx - e.x;
          const dy = ty - e.y;
          if (dtS > 0.02 && dtS < 0.3 && Math.hypot(dx, dy) < 250) {
            nvx = dx / dtS;
            nvy = dy / dtS;
            pl.vx = pl.vx * 0.6 + nvx * 0.4;
            pl.vy = pl.vy * 0.6 + nvy * 0.4;
          }
        }
        pl.tx = tx;
        pl.ty = ty;
        pl.ta = ta;
        pl.tlen = tlen;
        pl.thick = thick;
        pl.kills = row[10] as number;
        pl.shield = row[9] === 1;
        // Boost hysteresis: base speed ~170, boost ~320. Band 215–255 keeps
        // estimation noise from flickering the glow on/off.
        const spd = Math.hypot(pl.vx, pl.vy);
        if (!pl.boostVis && spd > 255) pl.boostVis = true;
        else if (pl.boostVis && spd < 215) pl.boostVis = false;
        // Rows carry an empty name slot (server slimmed them — names travel
        // via lb/kf/dead); only overwrite when something real arrives.
        const nm = row[11] as string;
        if (nm) pl.name = nm;
        pl.lastRowT = now;
      } else {
        this.players.set(id, this.makePlayer(row));
      }
    }
    // NOTE: absence from this message is NOT death — the server
    // interest-filters per client. Players age out via the TTL sweep in
    // update(); real deaths arrive as explicit `df` messages.
    if (this.players.has(this.myId)) this.alive = true;
  }

  /** Build a fresh PlayerState with a short seeded tail behind the head so
      a new/respawned snake is visible immediately instead of being a
      one-point invisible stub until it moves. */
  private makePlayer(row: unknown[]): PlayerState {
    const id = row[0] as number;
    const tx = row[1] as number;
    const ty = row[2] as number;
    const ta = row[3] as number;
    const tlen = row[4] as number;
    const thick = row[5] as number;
    const now = performance.now();
    // Chain seed sized to FULL length: every viewer immediately renders the
    // correct-length body, and the local follow-sim bends it toward the true
    // shape as head history replays. (A short "authority-completed" seed was
    // tried and reverted — without snapshot interpolation it jittered.)
    const n = Math.min(
      MAX_LOCAL_POINTS,
      Math.max(4, Math.round(tlen / SPACING)),
    );
    const cx = Math.cos(ta);
    const cy = Math.sin(ta);
    const px: number[] = [];
    const py: number[] = [];
    // Straight chain seeded behind the head (px[0] IS the head — mirrors the
    // server). The authoritative `b` snapshot corrects the true shape within
    // ~100ms; until then a straight body beats an invisible one.
    for (let k = 0; k < n; k++) {
      px.push(tx - cx * SPACING * k);
      py.push(ty - cy * SPACING * k);
    }
    return {
      id,
      name: (row[11] as string) || "",
      colorIdx: row[6] as number,
      patternIdx: row[7] as number,
      isBot: (row[8] as number) === 1,
      kills: row[10] as number,
      shield: row[9] === 1,
      boostVis: false,
      tx,
      ty,
      ta,
      tlen,
      thick,
      x: tx,
      y: ty,
      a: ta,
      len: tlen,
      px,
      py,
      total: (n - 1) * SPACING,
      vx: Math.cos(ta) * 170,
      vy: Math.sin(ta) * 170,
      // Seed the correction follower consistently so a newly-visible snake
      // moves INSTANTLY at base speed along its heading instead of freezing
      // until ~150ms of row history accumulates (the "snake glitches on
      // spawn" report). Rows correct the estimate within a few ticks.
      rvx: Math.cos(ta) * 170,
      rvy: Math.sin(ta) * 170,
      lastRowT: now,
      rowHist: [],
      body: null,
    };
  }

  /** Real deaths only (`df`): remove + play death FX at the reported spot. */
  applyDeaths(rows: unknown[]): void {
    for (const r of rows) {
      const d = r as number[];
      const pl = this.players.get(d[0] as number);
      if (pl) {
        this.deathFx.push([d[1] as number, d[2] as number, pl.colorIdx, pl.thick]);
        this.players.delete(pl.id);
      }
    }
  }

  /** Authoritative sampled bodies (`b`): store for rendering the tail. */
  applyBody(msg: Record<string, unknown>): void {
    const rows = (msg.p as unknown[]) ?? [];
    for (const r of rows) {
      const arr = r as number[];
      const pl = this.players.get(arr[0] as number);
      if (!pl) continue;
      // The first sample is the (stale) head — the client interpolates the
      // head itself; keep only the tail samples. Guard odd lengths: an
      // unpaired coordinate would break rendering.
      if ((arr.length - 1) % 2 !== 0) continue;
      const coords = arr.slice(2);
      if (coords.length >= 4) pl.body = coords;
    }
  }

  applyFullFood(f: unknown[]): void {
    this.food.clear();
    const now = performance.now();
    for (const row of f) {
      const r = row as [number, number, number, number, number?, number?];
      const isDrop = r[4] === 1;
      this.food.set(r[0], [r[1], r[2], r[3], isDrop ? now : 0, r[5] === 1 ? 1 : 0]);
    }
  }

  applyFoodEvents(msg: Record<string, unknown>): void {
    const now = performance.now();
    const keep = msg.k as unknown[];
    if (keep) {
      const next = new Map<number, [number, number, number, number, number?]>();
      for (const row of keep) {
        const r = row as [number, number, number, number, number?, number?];
        const isDrop = r[4] === 1;
        const old = this.food.get(r[0]);
        const dropT = isDrop ? (old ? old[3] : now) : 0;
        next.set(r[0], [r[1], r[2], r[3], dropT, r[5] === 1 ? 1 : (old?.[4] ?? 0)]);
      }
      for (const id of this.food.keys()) {
        if (!next.has(id)) this.food.delete(id);
      }
      for (const [id, v] of next) this.food.set(id, v);
      return;
    }
    const spawned = (msg.s as unknown[]) ?? [];
    for (const row of spawned) {
      const r = row as [number, number, number, number, number?, number?];
      const isDrop = r[4] === 1;
      this.food.set(r[0], [r[1], r[2], r[3], isDrop ? now : 0, r[5] === 1 ? 1 : 0]);
    }
    const removed = (msg.r as number[]) ?? [];
    for (const id of removed) {
      const f = this.food.get(id);
      // Sparkle only for food near US (BR purges remove far-off pellets and
      // must not spray eat-FX at the wall edge).
      if (f && (!this.getSelf() || Math.hypot(f[0] - this.getSelf()!.x, f[1] - this.getSelf()!.y) < 900)) {
        if (this.eatenFx.length >= 40) this.eatenFx.shift();
        this.eatenFx.push([f[0], f[1], f[2]]);
      }
      this.food.delete(id);
    }
  }

  getSelf(): PlayerState | null {
    return this.players.get(this.myId) ?? null;
  }

  /** Per-frame smoothing + local path building for every visible player. */
  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 24);
    const tick = 1000 / this.tickRate;
    const lookahead = Math.min(0.15, Math.max(0, this.ping / 2 + tick / 2) / 1000);
    const now = performance.now();
    for (const pl of this.players.values()) {
      // Out-of-interest cleanup: the server only broadcasts snakes near the
      // client. Age out silently (no death FX — a real death arrives as
      // `df`, and by TTL expiry the snake is far off-screen anyway).
      if (now - pl.lastRowT > 3000) {
        this.players.delete(pl.id);
        continue;
      }
      const fresh = now - pl.lastRowT < 300;
      const la = fresh ? lookahead : 0;
      // Predict the server position at render time: the last row is `age`
      // ms old, so extrapolate it by v*age instead of freezing the target
      // between rows. The interpolation target then moves at constant speed
      // and rendered motion stays smooth even though rows arrive at
      // irregular wall-clock intervals.
      const age = fresh ? (now - pl.lastRowT) / 1000 : 0;
      const ex = pl.tx + pl.vx * (age + la);
      const ey = pl.ty + pl.vy * (age + la);
      const exd = Math.hypot(ex - pl.tx, ey - pl.ty);
      const ex2 = exd > 30 ? pl.tx + (pl.vx / exd) * 30 : ex;
      const ey2 = exd > 30 ? pl.ty + (pl.vy / exd) * 30 : ey;
      if (fresh) {
        // Render at the estimated speed, heading driven by the smoothed
        // angle (so turns are continuous, never zigzag from row jumps),
        // plus a slow critically-damped correction follower that absorbs
        // row jumps/drift without pumping.
        const wn2 = 9; // 3 rad/s natural frequency (~0.5Hz)
        const damp = 6; // 2*wn, critically damped
        const v = Math.hypot(pl.vx, pl.vy);
        pl.x += Math.cos(pl.a) * v * dt;
        pl.y += Math.sin(pl.a) * v * dt;
        pl.rvx += ((ex2 - pl.x) * wn2 - pl.rvx * damp) * dt;
        pl.rvy += ((ey2 - pl.y) * wn2 - pl.rvy * damp) * dt;
        pl.x += pl.rvx * dt;
        pl.y += pl.rvy * dt;
      } else {
        pl.x += (ex2 - pl.x) * k;
        pl.y += (ey2 - pl.y) * k;
      }
      let d = pl.ta - pl.a;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      pl.a += d * k;
      pl.len = pl.tlen;

      // --- follow-the-leader chain — identical math to Player.move ---
      // px[0] IS the head. Segments closer than SPACING (inner rail of tight
      // turns) stay bunched — that asymmetry compacts loops exactly like the
      // authority does, so prediction never fights the snapshots. Squared-
      // distance gate mirrors the server (sqrt only on actual snaps).
      if (pl.px.length === 0) {
        pl.px.push(pl.x);
        pl.py.push(pl.y);
      }
      pl.px[0] = pl.x;
      pl.py[0] = pl.y;
      const spacingSq = SPACING * SPACING;
      for (let i = 1; i < pl.px.length; i++) {
        const ax = pl.px[i - 1]!;
        const ay = pl.py[i - 1]!;
        const dx = pl.px[i]! - ax;
        const dy = pl.py[i]! - ay;
        const d2 = dx * dx + dy * dy;
        if (d2 > spacingSq) {
          const dist = Math.sqrt(d2);
          const kk = SPACING / dist;
          pl.px[i] = ax + dx * kk;
          pl.py[i] = ay + dy * kk;
          pl.total += SPACING - dist;
        }
      }
      // Segment-count management toward pl.len — for EVERYONE (bounded growth
      // keeps big eats looking organic; shrink follows boost drain). New
      // segments extend OUTWARD from the true tail along its own direction.
      const desired = Math.min(MAX_LOCAL_POINTS, Math.max(4, Math.round(pl.len / SPACING)));
      let grown = 0;
      while (pl.px.length < desired && grown < 2) {
        const m = pl.px.length;
        const tx = pl.px[m - 1]!;
        const ty = pl.py[m - 1]!;
        let dx = tx - pl.px[m - 2]!;
        let dy = ty - pl.py[m - 2]!;
        const dl = Math.hypot(dx, dy) || 1;
        dx /= dl;
        dy /= dl;
        const ext = Math.min(SPACING * 0.6, dl * 0.5);
        pl.px.push(tx + dx * ext);
        pl.py.push(ty + dy * ext);
        pl.total += ext;
        grown++;
      }
      while (pl.px.length > desired && pl.px.length > 4) {
        const m = pl.px.length;
        pl.total -= Math.hypot(pl.px[m - 1]! - pl.px[m - 2]!, pl.py[m - 1]! - pl.py[m - 2]!);
        pl.px.pop();
        pl.py.pop();
      }
    }
  }
}
