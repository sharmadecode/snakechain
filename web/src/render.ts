import { GameState, PlayerState } from "./state";
import { baseColor, getBlockColor, shade, INK } from "./patterns";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

const ARENA_BG = "#0B1329"; // Deep dark navy blue playfield

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private leaderId = 0;

  // Particle pool for boost sparks and block burst explosions
  private fx: Particle[] = [];
  private readonly fxCap = 350;

  private camX = 0;
  private camY = 0;
  private camZoom = 1;

  private spinePX = new Float64Array(2000);
  private spinePY = new Float64Array(2000);
  private spineCum = new Float64Array(2000);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  private addFx(p: Particle): void {
    if (this.fx.length >= this.fxCap) this.fx.shift();
    this.fx.push(p);
  }

  private consumeFx(state: GameState, sx: (x: number) => number, sy: (y: number) => number): void {
    const deaths = state.deathFx;
    for (let k = 0; k < deaths.length; k++) {
      const [x, y, ci, thick] = deaths[k]!;
      const col = baseColor(ci);
      const n = 28;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
        const sp = 80 + Math.random() * 260;
        this.addFx({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 0.6 + Math.random() * 0.3,
          max: 0.9,
          size: 4 + Math.random() * (thick * 0.4),
          color: col,
        });
      }
    }
    deaths.length = 0;

    const eats = state.eatenFx;
    for (let k = 0; k < eats.length; k++) {
      const [x, y, ci] = eats[k]!;
      const col = baseColor(ci);
      for (let i = 0; i < 5; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 60 + Math.random() * 140;
        this.addFx({
          x,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 50,
          life: 0.3 + Math.random() * 0.2,
          max: 0.5,
          size: 3 + Math.random() * 4,
          color: col,
        });
      }
    }
    eats.length = 0;
  }

  private drawFx(dt: number, sx: (x: number) => number, sy: (y: number) => number, zoom: number): void {
    if (this.fx.length === 0) return;
    const ctx = this.ctx;

    for (let i = this.fx.length - 1; i >= 0; i--) {
      const p = this.fx[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        this.fx.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 120 * dt;
      const drag = Math.max(0, 1 - 2.2 * dt);
      p.vx *= drag;
      p.vy *= drag;

      const alpha = Math.max(0, p.life / p.max);
      const scx = sx(p.x);
      const scy = sy(p.y);
      const s = p.size * zoom;

      // Neo-brutalism square particle
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = INK;
      ctx.fillRect(scx - s / 2 + 2, scy - s / 2 + 2, s, s);
      ctx.fillStyle = p.color;
      ctx.fillRect(scx - s / 2, scy - s / 2, s, s);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(scx - s / 2, scy - s / 2, s, s);
      ctx.restore();
    }
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private camera(state: GameState, dt: number): { camX: number; camY: number; zoom: number } {
    const self = state.getSelf();
    if (!self) return { camX: this.camX, camY: this.camY, zoom: this.camZoom };
    const tx = self.x;
    const ty = self.y;
    const tz = Math.max(0.62, Math.min(1.55, 1.55 - self.len / 3200));

    if (Math.hypot(tx - this.camX, ty - this.camY) > 3000) {
      this.camX = tx;
      this.camY = ty;
      this.camZoom = tz;
    } else {
      const f = 1 - Math.exp(-dt * 10);
      this.camX += (tx - this.camX) * f;
      this.camY += (ty - this.camY) * f;
      this.camZoom += (tz - this.camZoom) * (1 - Math.exp(-dt * 4));
    }
    return { camX: this.camX, camY: this.camY, zoom: this.camZoom };
  }

  draw(state: GameState, dt: number): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

    const { camX, camY, zoom } = this.camera(state, dt);
    const viewR = Math.hypot(w, h) / (2 * zoom) + 140;
    const viewCX = camX;
    const viewCY = camY;
    const sx = (wx: number) => (wx - viewCX) * zoom + w / 2;
    const sy = (wy: number) => (wy - viewCY) * zoom + h / 2;

    ctx.clearRect(0, 0, w, h);

    // 1. Dark Blue Plain Ground Canvas
    this.drawGround(w, h);

    // 2. Circular Arena Boundary with Hazard Stripes
    this.drawWall(state, sx, sy, zoom);

    // 3. Food Energy Cubes (Uniform size + 4s death drop intense radiant glow)
    this.drawFood(state, viewCX, viewCY, viewR, sx, sy, zoom);

    // 4. Snake Square Block Chains (ordered by length)
    const players = [...state.players.values()].sort((a, b) => a.len - b.len);
    const inView = (pl: PlayerState): boolean => {
      const r2 = viewR * viewR;
      let dx = pl.x - viewCX;
      let dy = pl.y - viewCY;
      if (dx * dx + dy * dy <= r2) return true;
      for (let i = 0; i < pl.px.length; i += 6) {
        dx = pl.px[i]! - viewCX;
        dy = pl.py[i]! - viewCY;
        if (dx * dx + dy * dy <= r2) return true;
      }
      return false;
    };

    for (const pl of players) {
      if (!inView(pl)) continue;
      this.drawSnakeBlockChain(pl, sx, sy, zoom);
    }

    // 5. Snake Square Heads & Googly Eyes (Clean, no hovering name text)
    this.leaderId = state.leaderboard.length > 0 ? state.leaderboard[0]![0] : 0;
    for (const pl of players) {
      if (!inView(pl)) continue;
      this.drawSnakeBlockHead(pl, sx, sy, zoom);
    }

    // 6. Particles
    this.consumeFx(state, sx, sy);
    this.drawFx(dt, sx, sy, zoom);
  }

  private drawGround(w: number, h: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = ARENA_BG;
    ctx.fillRect(0, 0, w, h);
  }

  private drawWall(
    state: GameState,
    sx: (x: number) => number,
    sy: (y: number) => number,
    zoom: number,
  ): void {
    const ctx = this.ctx;
    const cx = sx(0);
    const cy = sy(0);
    const rad = state.halfW * zoom;
    const now = performance.now();

    ctx.save();

    // Outer hazard zone
    ctx.fillStyle = "rgba(255, 59, 48, 0.15)";
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 120 * zoom, 0, Math.PI * 2);
    ctx.arc(cx, cy, rad, 0, Math.PI * 2, true);
    ctx.fill();

    // Hard drop shadow
    ctx.strokeStyle = INK;
    ctx.lineWidth = 16 * zoom;
    ctx.beginPath();
    ctx.arc(cx + 4 * zoom, cy + 4 * zoom, rad, 0, Math.PI * 2);
    ctx.stroke();

    // Hazard striped border
    ctx.strokeStyle = "#FF3B30";
    ctx.lineWidth = 12 * zoom;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "#FFD93D";
    ctx.lineWidth = 12 * zoom;
    ctx.setLineDash([20 * zoom, 20 * zoom]);
    ctx.lineDashOffset = -(now * 0.03);
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Solid inner ink ring
    ctx.strokeStyle = INK;
    ctx.lineWidth = 4 * Math.max(1, zoom);
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  private drawFood(
    state: GameState,
    vx: number,
    vy: number,
    vr: number,
    sx: (x: number) => number,
    sy: (y: number) => number,
    zoom: number,
  ): void {
    const ctx = this.ctx;
    // Uniform compact food size for all energy cubes
    const s = 11 * Math.max(0.7, Math.min(1.3, zoom));
    const halfS = s / 2;
    const now = performance.now();

    for (const [id, f] of state.food) {
      if (Math.abs(f[0] - vx) > vr || Math.abs(f[1] - vy) > vr) continue;
      const x = sx(f[0]);
      const y = sy(f[1]);
      const colorIdx = f[2] % 12;
      const col = baseColor(colorIdx);
      const dropSpawnT = f[3] ?? 0;
      const age = dropSpawnT > 0 ? (now - dropSpawnT) : Infinity;
      const isGlowingDrop = age < 4000;

      const rot = (now * 0.0015 + id * 1.3) % (Math.PI * 2);

      ctx.save();
      ctx.translate(x, y);

      // 4-Second Intense Death Drop Glow Halo
      if (isGlowingDrop) {
        const glowRatio = 1.0 - (age / 4000);
        const pulse = 1.0 + 0.3 * Math.sin(now * 0.012 + id);
        const haloR = s * 2.8 * pulse * glowRatio;

        const halo = ctx.createRadialGradient(0, 0, s * 0.2, 0, 0, haloR);
        halo.addColorStop(0, shade(col, 0.6));
        halo.addColorStop(0.4, col);
        halo.addColorStop(1, "rgba(0, 0, 0, 0)");

        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(0, 0, haloR, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.rotate(rot);

      // Clean cube main face
      ctx.fillStyle = col;
      ctx.fillRect(-halfS, -halfS, s, s);

      // Clean crisp border
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(1.8, 2 * zoom);
      ctx.strokeRect(-halfS, -halfS, s, s);

      // Top-left subtle bevel
      ctx.fillStyle = shade(col, 0.35);
      ctx.fillRect(-halfS + 1.5 * zoom, -halfS + 1.5 * zoom, s - 3 * zoom, Math.max(1.5, 2.5 * zoom));
      ctx.fillRect(-halfS + 1.5 * zoom, -halfS + 1.5 * zoom, Math.max(1.5, 2.5 * zoom), s - 3 * zoom);

      ctx.restore();
    }
  }

  /**
   * Render Blocky Square Chain Snake Body
   * Cycles through the 5 customizable colors: [C0, C1, C2, C3, C4, C0, C1, ...]
   */
  private drawSnakeBlockChain(
    pl: PlayerState,
    sx: (x: number) => number,
    sy: (y: number) => number,
    zoom: number,
  ): void {
    const ctx = this.ctx;
    const n = pl.px.length;
    if (n < 2) return;

    const thick = pl.thick * zoom;
    const blockSize = thick * 0.95;
    const stepDist = Math.max(5, thick * 0.65);

    const body = pl.body;
    let localTotal = 0;
    for (let i = 0; i < n; i++) {
      const dx = i === 0 ? pl.x - pl.px[0]! : pl.px[i - 1]! - pl.px[i]!;
      const dy = i === 0 ? pl.y - pl.py[0]! : pl.py[i - 1]! - pl.py[i]!;
      localTotal += Math.hypot(dx, dy);
    }

    let tailStart = 0;
    let tailLen = 0;
    if (body && body.length >= 4 && localTotal < pl.len - 20) {
      let acc = 0;
      let prevX = pl.x;
      let prevY = pl.y;
      for (let i = 0; i + 1 < body.length; i += 2) {
        acc += Math.hypot(body[i]! - prevX, body[i + 1]! - prevY);
        prevX = body[i]!;
        prevY = body[i + 1]!;
        if (acc >= localTotal - 12) {
          tailStart = i;
          tailLen = body.length - i;
          break;
        }
      }
    }

    const ptsCount = Math.min(1990, n + 1 + Math.floor(tailLen / 2));
    const px = this.spinePX;
    const py = this.spinePY;
    const cum = this.spineCum;

    px[0] = pl.x;
    py[0] = pl.y;
    let k = 1;
    for (let i = 0; i < n && k < ptsCount; i++) {
      px[k] = pl.px[i]!;
      py[k] = pl.py[i]!;
      k++;
    }
    if (tailLen > 0 && body) {
      for (let i = tailStart; i + 1 < body.length && k < ptsCount; i += 2) {
        px[k] = body[i]!;
        py[k] = body[i + 1]!;
        k++;
      }
    }

    cum[0] = 0;
    for (let i = 1; i < k; i++) {
      cum[i] = cum[i - 1]! + Math.hypot(px[i]! - px[i - 1]!, py[i]! - py[i - 1]!);
    }
    const totalDist = cum[k - 1]!;
    if (totalDist < 1) return;
    const maxDist = Math.min(totalDist, pl.len);

    // Pre-calculate block positions stepping from head to tail with tight overlapping steps
    const blocks: Array<{ wx: number; wy: number; angle: number; size: number; blockIdx: number }> = [];
    let curD = Math.max(4, blockSize * 0.38);
    let bIdx = 1;
    let j = 0;

    while (curD <= maxDist) {
      const distFromTail = maxDist - curD;
      let taper = 1.0;
      if (distFromTail < blockSize * 2.8) {
        taper = 0.52 + 0.48 * (distFromTail / (blockSize * 2.8));
      }
      const curSize = blockSize * taper;

      while (j < k - 2 && cum[j + 1]! < curD) j++;
      while (j > 0 && cum[j]! > curD) j--;
      const segLen = cum[j + 1]! - cum[j]!;
      if (segLen >= 1e-4) {
        const t = Math.min(1, Math.max(0, (curD - cum[j]!) / segLen));
        const wx = px[j]! + (px[j + 1]! - px[j]!) * t;
        const wy = py[j]! + (py[j + 1]! - py[j]!) * t;
        const angle = Math.atan2(py[j]! - py[j + 1]!, px[j]! - px[j + 1]!);
        blocks.push({ wx, wy, angle, size: curSize, blockIdx: bIdx });
      }

      // Adaptive tight step based on current tapered size so there are ZERO gaps anywhere
      const step = Math.max(3.5, curSize * 0.40);
      curD += step;
      bIdx++;
    }

    // Render from tail to head (so forward body and head draw cleanly on top)
    for (let b = blocks.length - 1; b >= 0; b--) {
      const blk = blocks[b]!;
      const scx = sx(blk.wx);
      const scy = sy(blk.wy);
      const curHalf = blk.size / 2;
      const cornerR = Math.max(2, 4 * zoom);
      const col = getBlockColor(pl.colorIdx, blk.blockIdx);

      ctx.save();
      ctx.translate(scx, scy);
      ctx.rotate(blk.angle);

      // 1. Clean Block Face Fill
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(-curHalf, -curHalf, blk.size, blk.size, cornerR);
      ctx.fill();

      // 2. Crisp Clean Outline
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(2, 2.5 * zoom);
      ctx.stroke();

      // 3. Subtle Bevel Highlight
      ctx.fillStyle = shade(col, 0.35);
      ctx.beginPath();
      ctx.roundRect(-curHalf + 2 * zoom, -curHalf + 2 * zoom, blk.size - 4 * zoom, Math.max(2, 3 * zoom), cornerR / 2);
      ctx.fill();

      ctx.restore();
    }
  }

  /**
   * Render Square Head Block with Expressive Googly Eyes
   */
  private drawSnakeBlockHead(
    pl: PlayerState,
    sx: (x: number) => number,
    sy: (y: number) => number,
    zoom: number,
  ): void {
    const ctx = this.ctx;
    const hx = sx(pl.x);
    const hy = sy(pl.y);
    const headSize = pl.thick * 1.15 * zoom;
    const halfHead = headSize / 2;
    const cornerR = Math.max(3, 6 * zoom);
    const headColor = getBlockColor(pl.colorIdx, 0);

    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(pl.a);

    // 1. Clean Head Main Block
    ctx.fillStyle = headColor;
    ctx.beginPath();
    ctx.roundRect(-halfHead, -halfHead, headSize, headSize, cornerR);
    ctx.fill();

    // 2. Thick Crisp Outline
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(2.5, 3.2 * zoom);
    ctx.stroke();

    // 3. Googly Eyes
    const eyeSize = headSize * 0.38;
    const halfEye = eyeSize / 2;
    const pupilSize = eyeSize * 0.52;
    const eyeOffsetX = headSize * 0.16;
    const eyeOffsetY = headSize * 0.28;

    const eyeOffsets = [-eyeOffsetY, eyeOffsetY];

    for (const ey of eyeOffsets) {
      const ex = eyeOffsetX;

      // Eye White Socket
      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.roundRect(ex - halfEye, ey - halfEye, eyeSize, eyeSize, cornerR / 2);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(1.5, 2 * zoom);
      ctx.stroke();

      // Black Pupil
      const px = ex + eyeSize * 0.15;
      const py = ey;
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.roundRect(px - pupilSize / 2, py - pupilSize / 2, pupilSize, pupilSize, cornerR / 3);
      ctx.fill();

      // Catchlight Glint
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(px - pupilSize * 0.35, py - pupilSize * 0.35, pupilSize * 0.35, pupilSize * 0.35);
    }

    ctx.restore();

    // 4. Crown on #1 Leader
    if (pl.id === this.leaderId) {
      this.drawCrown(hx, hy - halfHead - 24 * zoom, headSize * 0.7, zoom);
    }
  }

  private drawCrown(cx: number, cy: number, s: number, zoom: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(cx, cy);

    // Hard Shadow
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(-s / 2 + 3, s * 0.28 + 3);
    ctx.lineTo(-s / 2 + 3, -s * 0.22 + 3);
    ctx.lineTo(-s / 4 + 3, 3);
    ctx.lineTo(3, -s * 0.5 + 3);
    ctx.lineTo(s / 4 + 3, 3);
    ctx.lineTo(s / 2 + 3, -s * 0.22 + 3);
    ctx.lineTo(s / 2 + 3, s * 0.28 + 3);
    ctx.closePath();
    ctx.fill();

    // Crown Fill
    ctx.fillStyle = "#FFD93D";
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(2, 2.5 * zoom);
    ctx.beginPath();
    ctx.moveTo(-s / 2, s * 0.28);
    ctx.lineTo(-s / 2, -s * 0.22);
    ctx.lineTo(-s / 4, 0);
    ctx.lineTo(0, -s * 0.5);
    ctx.lineTo(s / 4, 0);
    ctx.lineTo(s / 2, -s * 0.22);
    ctx.lineTo(s / 2, s * 0.28);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Ruby jewels
    ctx.fillStyle = "#FF3B30";
    ctx.fillRect(-s / 4 - 2, s * 0.05, 5 * zoom, 5 * zoom);
    ctx.fillRect(s / 4 - 3, s * 0.05, 5 * zoom, 5 * zoom);
    ctx.fillRect(-2, -s * 0.25, 5 * zoom, 5 * zoom);

    ctx.restore();
  }
}
