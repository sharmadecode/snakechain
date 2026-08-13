export interface PlayerState {
  id: number;
  name: string;
  colorIdx: number;
  patternIdx: number;
  isBot: boolean;
  kills: number;
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
  wall?: boolean;
}

const SPACING = 10;

export class GameState {
  myId = 0;
  halfW = 900;
  halfH = 900;
  tickRate = 30;
  players = new Map<number, PlayerState>();
  /** id -> [x, y, colorIdx, dropSpawnTimeMs] */
  food = new Map<number, [number, number, number, number]>();
  leaderboard: Array<[number, string, number, number, number]> = [];
  ping = -1;
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
    this.dead = null;
    this.alive = false;
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
        pl.name = row[11] as string;
        pl.lastRowT = now;
        this.extendTail(pl);
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
    const seedN = 8;
    const cx = Math.cos(ta);
    const cy = Math.sin(ta);
    const px: number[] = [];
    const py: number[] = [];
    for (let k = 1; k <= seedN; k++) {
      px.push(tx - cx * SPACING * k);
      py.push(ty - cy * SPACING * k);
    }
    return {
      id,
      name: row[11] as string,
      colorIdx: row[6] as number,
      patternIdx: row[7] as number,
      isBot: (row[8] as number) === 1,
      kills: row[10] as number,
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
      total: seedN * SPACING,
      vx: 0,
      vy: 0,
      rvx: 0,
      rvy: 0,
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
      const r = row as [number, number, number, number, number?];
      const isDrop = r[4] === 1;
      this.food.set(r[0], [r[1], r[2], r[3], isDrop ? now : 0]);
    }
  }

  applyFoodEvents(msg: Record<string, unknown>): void {
    const now = performance.now();
    const keep = msg.k as unknown[];
    if (keep) {
      const next = new Map<number, [number, number, number, number]>();
      for (const row of keep) {
        const r = row as [number, number, number, number, number?];
        const isDrop = r[4] === 1;
        const old = this.food.get(r[0]);
        const dropT = isDrop ? (old ? old[3] : now) : 0;
        next.set(r[0], [r[1], r[2], r[3], dropT]);
      }
      for (const id of this.food.keys()) {
        if (!next.has(id)) this.food.delete(id);
      }
      for (const [id, v] of next) this.food.set(id, v);
      return;
    }
    const spawned = (msg.s as unknown[]) ?? [];
    for (const row of spawned) {
      const r = row as [number, number, number, number, number?];
      const isDrop = r[4] === 1;
      this.food.set(r[0], [r[1], r[2], r[3], isDrop ? now : 0]);
    }
    const removed = (msg.r as number[]) ?? [];
    for (const id of removed) {
      const f = this.food.get(id);
      if (f) {
        if (this.eatenFx.length >= 40) this.eatenFx.shift();
        this.eatenFx.push([f[0], f[1], f[2]]);
      }
      this.food.delete(id);
    }
  }

  getSelf(): PlayerState | null {
    return this.players.get(this.myId) ?? null;
  }

  /** Mirror the server's tail extension: when a big eat makes the target
      length outgrow the locally-built path, extend the path at the tail so
      the body grows from the tail instantly (like the server does). */
  private extendTail(pl: PlayerState): void {
    if (pl.tlen <= pl.total + 60) return;
    const n = pl.px.length;
    if (n < 2) return;
    const dx = pl.px[n - 1]! - pl.px[n - 2]!;
    const dy = pl.py[n - 1]! - pl.py[n - 2]!;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    let need = pl.tlen - pl.total;
    let added = 0;
    while (need > 4 && added < Math.max(0, 1200 - n)) {
      const lx = pl.px[pl.px.length - 1]!;
      const ly = pl.py[pl.py.length - 1]!;
      pl.px.push(lx + ux * SPACING);
      pl.py.push(ly + uy * SPACING);
      pl.total += SPACING;
      need -= SPACING;
      added++;
    }
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

      const dx = pl.x - (pl.px[0] ?? pl.x);
      const dy = pl.y - (pl.py[0] ?? pl.y);
      const moved = Math.hypot(dx, dy);
      if (pl.px.length === 0) {
        pl.px.push(pl.x);
        pl.py.push(pl.y);
        pl.total = 0;
      } else if (moved >= SPACING) {
        pl.px.unshift(pl.x);
        pl.py.unshift(pl.y);
        pl.total += moved;
      }
      let guard = pl.px.length;
      while (pl.px.length > 2 && guard-- > 0 && pl.px.length > 1200) {
        const n = pl.px.length;
        pl.total -= Math.hypot(pl.px[n - 2]! - pl.px[n - 1]!, pl.py[n - 2]! - pl.py[n - 1]!);
        pl.px.pop();
        pl.py.pop();
      }
      // Shrink the tail smoothly: slide the last vertex toward its
      // neighbour by the excess instead of popping whole segments, so the
      // tail end glides when boosting (draining length) instead of snapping.
      const budget = pl.len + 50;
      if (pl.px.length > 2 && pl.total > budget) {
        let excess = pl.total - budget;
        let g = 8;
        while (pl.px.length > 2 && excess > 0.01 && g-- > 0) {
          const n = pl.px.length;
          const sx = pl.px[n - 1]! - pl.px[n - 2]!;
          const sy = pl.py[n - 1]! - pl.py[n - 2]!;
          const seg = Math.hypot(sx, sy);
          if (seg <= 0.001) {
            pl.px.pop();
            pl.py.pop();
            pl.total -= seg;
            continue;
          }
          if (seg <= excess) {
            pl.px.pop();
            pl.py.pop();
            pl.total -= seg;
            excess -= seg;
          } else {
            const f = (seg - excess) / seg;
            pl.px[n - 1] = pl.px[n - 2]! + sx * f;
            pl.py[n - 1] = pl.py[n - 2]! + sy * f;
            pl.total -= excess;
            excess = 0;
          }
        }
      }
    }
  }
}
