import { GameState, PlayerState } from "./state";
import { baseColor, shade, unpackColors, INK, DEATH_DROP_GLOW_MS, PALETTE } from "./patterns";

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

interface Block {
  wx: number;
  wy: number;
  angle: number;
  size: number;
  blockIdx: number;
}

const ARENA_BG = "#050B18"; // Deep dark navy playfield (kept clean/dark — no powder)

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private leaderId = 0;

  /** Pre-rendered floor tile (grid + soft tint blobs) — world-aligned via
      createPattern so the ground scrolls with the camera. One fillRect per
      frame replaces the flat color and gives the arena depth for free. */
  private bgPattern: CanvasPattern | null = null;

  /** Pre-rendered food sprites (glow + shadow + face + bevel), one per
      palette color. A single drawImage per food item replaces 4 path ops,
      so it is BOTH prettier (soft glow) and cheaper per frame. */
  private foodSprites: HTMLCanvasElement[] | null = null;

  /** Pre-rendered block sprites ×12 (96px): vertical-lit rounded face,
      ink border, top bevel, bottom AO strip — all baked once, then stamped
      with one drawImage per block. The face occupies the central 72px. */
  private blockSprites: HTMLCanvasElement[][] | null = null;

  /** Additive boost-glow blooms ×12 (one per palette color). Stamped under
      each block ONLY while that snake boosts — the whole snake glows in its
      own chain colors. Composite ‘lighter’ so the dark floor lights up richly. */
  private boostGlows: HTMLCanvasElement[] | null = null;

  // Particle pool for boost sparks and block burst explosions
  private fx: Particle[] = [];
  private readonly fxCap = 350;

  private camX = 0;
  private camY = 0;
  private camZoom = 1;

  private spinePX = new Float64Array(2000);
  private spinePY = new Float64Array(2000);
  private spineCum = new Float64Array(2000);

  // Per-snake resolved color cycle (invalidated when the packed color
  // changes) — avoids re-unpacking per block per frame. PlayerState objects
  // are recreated on respawn, so a WeakMap stays bounded.
  private colorCache = new WeakMap<PlayerState, { packed: number; colors: string[] }>();
  /** Memoized brightened colors for death-drop glow halos (≤ palette size). */
  private glowCache = new Map<string, string>();
  // Reused draw buffers — zero steady-state allocation per frame.
  private sortBuf: PlayerState[] = [];
  private blockPool: Block[] = [];
  private visibleBuf: PlayerState[] = [];
  /** Adaptive quality (RD-05): frame-time watchdog in main.ts downgrades to
      DPR 1 on sustained slow frames; upgrade path restores sharpness. */
  private dprCap = 2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  setQualityLevel(low: boolean): void {
    const cap = low ? 1 : 2;
    if (cap !== this.dprCap) {
      this.dprCap = cap;
      this.resize();
    }
  }

  private glowOf(col: string): string {
    let g = this.glowCache.get(col);
    if (g === undefined) {
      g = shade(col, 0.6);
      this.glowCache.set(col, g);
    }
    return g;
  }

  private colorsFor(pl: PlayerState): string[] {
    let entry = this.colorCache.get(pl);
    if (!entry || entry.packed !== pl.colorIdx) {
      entry = { packed: pl.colorIdx, colors: unpackColors(pl.colorIdx).map((ci) => baseColor(ci)) };
      this.colorCache.set(pl, entry);
    }
    return entry.colors;
  }

  private addFx(p: Particle): void {
    if (this.fx.length >= this.fxCap) this.fx.shift();
    this.fx.push(p);
  }

  private consumeFx(state: GameState): void {
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
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private ensureBackgrounds(): void {
    if (!this.bgPattern) {
      const t = document.createElement("canvas");
      t.width = 160;
      t.height = 160;
      const g = t.getContext("2d")!;
      g.fillStyle = ARENA_BG;
      g.fillRect(0, 0, 160, 160);
      g.strokeStyle = "rgba(148, 163, 255, 0.024)";
      g.lineWidth = 1;
      for (let i = 0; i <= 160; i += 40) {
        g.beginPath();
        g.moveTo(i + 0.5, 0);
        g.lineTo(i + 0.5, 160);
        g.stroke();
        g.beginPath();
        g.moveTo(0, i + 0.5);
        g.lineTo(160, i + 0.5);
        g.stroke();
      }
      const blob = (x: number, y: number, r: number, col: string): void => {
        const rg = g.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, col);
        rg.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = rg;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      };
      blob(30, 122, 72, "rgba(124, 92, 255, 0.02)");
      blob(132, 28, 84, "rgba(0, 194, 209, 0.018)");
      this.bgPattern = this.ctx.createPattern(t, "repeat");
    }
    if (!this.blockSprites) {
      const SPR = 96;
      const FACE = 72;
      const m = SPR / 2;
      const f = FACE / 2;
      // Bake one sprite PER (pattern-variant × palette color): 6×12 canvases.
      // Per-block draw cost stays a single drawImage — patterns are free at
      // runtime because all the raster work happens once, here.
      // Variants: 0 solid · 1 stripes · 2 tail-fade · 3 spots · 4 dark band · 5 ink accent
      const bake = (hex: string, pat: number): HTMLCanvasElement => {
        const c = document.createElement("canvas");
        c.width = SPR;
        c.height = SPR;
        const g = c.getContext("2d")!;
        if (pat === 4) {
          // Dark band variant — flat deepened face
          g.fillStyle = shade(hex, -0.30);
          g.beginPath();
          g.roundRect(m - f, m - f, FACE, FACE, 16);
          g.fill();
        } else if (pat === 5) {
          // Ink accent variant — near-black face with a whisper of color
          g.fillStyle = shade(hex, -0.78);
          g.beginPath();
          g.roundRect(m - f, m - f, FACE, FACE, 16);
          g.fill();
        } else {
          const lg =
            pat === 2
              ? g.createLinearGradient(m + f, 0, m - f, 0) // fade runs head→tail
              : g.createLinearGradient(0, m - f, 0, m + f);
          lg.addColorStop(0, shade(hex, pat === 2 ? 0.15 : 0.32));
          lg.addColorStop(0.45, hex);
          lg.addColorStop(1, shade(hex, pat === 2 ? -0.5 : -0.24));
          g.fillStyle = lg;
          g.beginPath();
          g.roundRect(m - f, m - f, FACE, FACE, 16);
          g.fill();
        }
        // Crisp ink border
        g.strokeStyle = INK;
        g.lineWidth = 6;
        g.stroke();
        // Top bevel + bottom AO strips
        g.fillStyle = "rgba(255,255,255,0.5)";
        g.fillRect(m - f + 7, m - f + 7, FACE - 14, 8);
        g.fillStyle = "rgba(0,0,0,0.30)";
        g.fillRect(m - f + 7, m + f - 15, FACE - 14, 8);
        if (pat === 1) {
          // Stripes: two ink bands ACROSS the body (body runs along local X)
          g.fillStyle = "rgba(20,20,20,0.30)";
          g.fillRect(m - f + 14, m - f + 6, 9, FACE - 12);
          g.fillRect(m - f + 42, m - f + 6, 9, FACE - 12);
        }
        if (pat === 3) {
          // Spots: centered contrasting square on every block using this variant
          g.fillStyle = "rgba(20,20,20,0.38)";
          g.beginPath();
          g.roundRect(m - 11, m - 11, 22, 22, 6);
          g.fill();
          g.fillStyle = "rgba(255,255,255,0.35)";
          g.fillRect(m - 7, m - 7, 5, 5);
        }
        return c;
      };
      this.blockSprites = [0, 1, 2, 3, 4, 5].map((pat) => PALETTE.map((hex) => bake(hex, pat)));
    }
    if (!this.boostGlows) {
      this.boostGlows = PALETTE.map((hex) => {
        const c = document.createElement("canvas");
        c.width = 128;
        c.height = 128;
        const g = c.getContext("2d")!;
        const rg = g.createRadialGradient(64, 64, 10, 64, 64, 63);
        rg.addColorStop(0, hex + "73");
        rg.addColorStop(0.45, hex + "2e");
        rg.addColorStop(1, hex + "00");
        g.fillStyle = rg;
        g.fillRect(0, 0, 128, 128);
        return c;
      });
    }
    if (!this.foodSprites) {
      const SPR = 64;
      const CUBE = 26;
      const INK_LINE = 2.5;
      this.foodSprites = PALETTE.map((hex) => {
        const c = document.createElement("canvas");
        c.width = SPR;
        c.height = SPR;
        const g = c.getContext("2d")!;
        const m = SPR / 2;
        const rg = g.createRadialGradient(m, m, CUBE * 0.25, m, m, SPR / 2 - 1);
        rg.addColorStop(0, hex + "36");
        rg.addColorStop(1, hex + "00");
        g.fillStyle = rg;
        g.fillRect(0, 0, SPR, SPR);
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.fillRect(m - CUBE / 2 + 3, m - CUBE / 2 + 4, CUBE, CUBE);
        g.fillStyle = hex;
        g.fillRect(m - CUBE / 2, m - CUBE / 2, CUBE, CUBE);
        g.strokeStyle = INK;
        g.lineWidth = INK_LINE;
        g.strokeRect(m - CUBE / 2, m - CUBE / 2, CUBE, CUBE);
        g.fillStyle = "rgba(255,255,255,0.45)";
        g.fillRect(m - CUBE / 2 + 2, m - CUBE / 2 + 2, CUBE - 4, 3);
        g.fillStyle = "rgba(0,0,0,0.28)";
        g.fillRect(m - CUBE / 2 + 2, m + CUBE / 2 - 5, CUBE - 4, 3);
        return c;
      });
    }
  }

  private camera(state: GameState, dt: number): { camX: number; camY: number; zoom: number } {
    // Focus priority: own snake → spectated killer (death cam) → frozen.
    let focus = state.getSelf();
    if (!focus && state.spectateId) {
      focus = state.players.get(state.spectateId) ?? null;
    }
    if (!focus) return { camX: this.camX, camY: this.camY, zoom: this.camZoom };
    const tx = focus.x;
    const ty = focus.y;
    const tz = Math.max(0.62, Math.min(1.55, 1.55 - focus.len / 3200));

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

    // 1. World-aligned patterned ground (scrolls with the camera)
    this.drawGround(camX, camY, zoom, w, h);

    // 2. Circular Arena Boundary with Hazard Stripes
    this.drawWall(state, sx, sy, zoom);

    // 3. Food Energy Cubes (Uniform size + 4s death drop intense radiant glow)
    this.drawFood(state, viewCX, viewCY, viewR, sx, sy, zoom);

    // 4. Snake Square Block Chains (ordered by length)
    const players = this.sortBuf;
    players.length = 0;
    for (const p of state.players.values()) players.push(p);
    players.sort((a, b) => a.len - b.len);
    const inView = (pl: PlayerState): boolean => {
      const r2 = viewR * viewR;
      let dx = pl.x - viewCX;
      let dy = pl.y - viewCY;
      if (dx * dx + dy * dy <= r2) return true;
      // A long snake whose head is off-screen can still have its body
      // crossing the view — and that body is lethal (server collision is
      // authoritative). Culling by head/local-path alone rendered such
      // snakes invisible while they could still kill you. The local path
      // only covers ground the head covered WHILE visible; the rest of the
      // body lives only in the authoritative `body` samples.
      // ~30 u sampling along the locally-built path (points sit ~10 u
      // apart): dense enough that no lethal segment can hide between checks.
      for (let i = 0; i < pl.px.length; i += 3) {
        dx = pl.px[i]! - viewCX;
        dy = pl.py[i]! - viewCY;
        if (dx * dx + dy * dy <= r2) return true;
      }
      const body = pl.body;
      if (body) {
        // Every 2nd sample (~44 u spacing): sparser strides let a body that
        // grazes the screen edge slip BETWEEN samples and render invisible
        // while still lethal — an invisible-killer report had exactly this
        // shape. Samples are capped (BODY_SAMPLE_CAP) so cost stays tiny.
        for (let i = 0; i + 1 < body.length; i += 4) {
          dx = body[i]! - viewCX;
          dy = body[i + 1]! - viewCY;
          if (dx * dx + dy * dy <= r2) return true;
        }
      }
      return false;
    };

    // Cull once — bodies and heads share this list instead of re-running
    // the (non-trivial) inView walk twice per player per frame.
    const visible = this.visibleBuf;
    visible.length = 0;
    for (const pl of players) {
      if (inView(pl)) visible.push(pl);
    }

    for (const pl of visible) {
      // Remote tail-stitching is DISABLED: it spliced sparse ~100ms-old server
      // samples onto remote chains whenever they ate, reading as jitter. Local
      // full-length simulation converges to truth on its own and stays smooth.
      // To re-enable truthing patches: pass `pl.id !== state.myId` here.
      this.drawSnakeBlockChain(pl, sx, sy, zoom, false);    }

    // 5. Snake Square Heads & Googly Eyes (Clean, no hovering name text)
    this.leaderId = state.leaderboard.length > 0 ? state.leaderboard[0]![0] : 0;
    for (const pl of visible) {
      this.drawSnakeBlockHead(pl, sx, sy, zoom);
    }

    // 6. Particles
    this.consumeFx(state);
    this.drawFx(dt, sx, sy, zoom);
  }

  private drawGround(camX: number, camY: number, zoom: number, w: number, h: number): void {
    this.ensureBackgrounds();
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(w / 2 - camX * zoom, h / 2 - camY * zoom);
    ctx.scale(zoom, zoom);
    ctx.fillStyle = this.bgPattern!;
    const hw = w / (2 * zoom) + 80;
    const hh = h / (2 * zoom) + 80;
    ctx.fillRect(camX - hw, camY - hh, hw * 2, hh * 2);
    ctx.restore();
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

    // Dim everything beyond the boundary so the arena reads as a lit island
    // floating in dark space (one even-odd fill per frame).
    ctx.beginPath();
    const far = rad + 4000;
    ctx.rect(cx - far, cy - far, far * 2, far * 2);
    ctx.arc(cx, cy, rad + 6, 0, Math.PI * 2, true);
    ctx.fillStyle = "rgba(3, 6, 16, 0.55)";
    ctx.fill("evenodd");

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
    const now = performance.now();

    // Eat-magnetism anchor: pellets near OUR head lean toward the mouth as we
    // approach (slither-style anticipation). Purely cosmetic render offset —
    // stored positions and server collision are never touched.
    const me = state.getSelf();
    const MAG_RANGE = 90;
    const MAG_PULL = 22;

    for (const [id, f] of state.food) {
      let fxw = f[0];
      let fyw = f[1];
      if (me) {
        const dxm = me.x - fxw;
        const dym = me.y - fyw;
        const dm = Math.hypot(dxm, dym);
        if (dm < MAG_RANGE && dm > 1) {
          const pull = Math.pow(1 - dm / MAG_RANGE, 1.4) * MAG_PULL;
          fxw += (dxm / dm) * pull;
          fyw += (dym / dm) * pull;
        }
      }
      if (Math.abs(fxw - vx) > vr || Math.abs(fyw - vy) > vr) continue;
      const x = sx(fxw);
      const y = sy(fyw);
      const colorIdx = f[2] % 12;
      const col = baseColor(colorIdx);
      const gold = f[4] === 1;
      const dropSpawnT = f[3] ?? 0;
      const age = dropSpawnT > 0 ? (now - dropSpawnT) : Infinity;
      const isGlowingDrop = age < DEATH_DROP_GLOW_MS;

      const rot = (now * 0.0015 + id * 1.3) % (Math.PI * 2);

      ctx.save();
      ctx.translate(x, y);

      // Golden pellet: pulsing halo ring (always on) — drawn under the cube.
      if (gold) {
        const pr = s * 2.4 * (0.85 + 0.15 * Math.sin(now * 0.005 + id));
        ctx.strokeStyle = "rgba(255, 217, 61, 0.5)";
        ctx.lineWidth = Math.max(1.5, 2 * zoom);
        ctx.beginPath();
        ctx.arc(0, 0, pr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 4-Second Intense Death Drop Glow Halo
      if (isGlowingDrop) {
        const glowRatio = 1.0 - (age / DEATH_DROP_GLOW_MS);
        const pulse = 1.0 + 0.3 * Math.sin(now * 0.012 + id);
        const haloR = s * 2.8 * pulse * glowRatio;

        const halo = ctx.createRadialGradient(0, 0, s * 0.2, 0, 0, haloR);
        halo.addColorStop(0, this.glowOf(col));
        halo.addColorStop(0.4, col);
        halo.addColorStop(1, "rgba(0, 0, 0, 0)");

        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(0, 0, haloR, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.rotate(rot);

      // Pre-rendered sprite: soft glow + drop shadow + face + bevel in ONE
      // drawImage (cheaper than the old 4 path ops AND much prettier).
      const spr = this.foodSprites![colorIdx]!;
      const k = (gold ? s * 1.35 : s) / 26; // sprite's cube edge is 26px
      ctx.drawImage(spr, -32 * k, -32 * k, 64 * k, 64 * k);
      if (gold) {
        // Two orbiting white glints — reads as "this one is special".
        const tw = now * 0.003 + id;
        const d = s * 1.05;
        const r2 = Math.max(1.5, s * 0.16);
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        for (const o of [tw, tw + Math.PI]) {
          ctx.fillRect(Math.cos(o) * d - r2, Math.sin(o) * d - r2, r2 * 2, r2 * 2);
        }
      }

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
    canStitch: boolean,
  ): void {
    const ctx = this.ctx;
    const n = pl.px.length;
    if (n < 2) return;

    const thick = pl.thick * zoom;
    const blockSize = thick * 0.95;

    const body = pl.body;
    // Path length is maintained incrementally in state.update (unshift adds
    // `moved`, crops subtract popped segments) — only the head-to-first-
    // point gap is missing, so no O(n) rewalk is needed here.
    const headGap = pl.px.length > 0 ? Math.hypot(pl.x - pl.px[0]!, pl.y - pl.py[0]!) : 0;
    const localTotal = pl.total + headGap;

    let tailStart = 0;
    let tailLen = 0;
    // Tail stitching — REMOTE snakes only (self is simulated identically to
    // the server, so splicing stale samples onto it caused the eat-time tail
    // jump; remotes get their shape trued-up from authoritative samples).
    if (canStitch && body && body.length >= 4 && pl.len - localTotal > 20) {
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

    // NOTE: the serpentine cosmetic wave was REMOVED by operator decision —
    // any residual tail-block motion it caused outweighed the flavor. The
    // body's organic look comes purely from the follow-the-leader chain
    // physics (loop compaction, corner cutting) which remains untouched.

    // Pre-calculate block positions stepping from head to tail with tight
    // overlapping steps. Blocks come from a persistent pool (one object per
    // slot, reused every frame) instead of thousands of fresh allocations.
    let blockCount = 0;
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
        const blk = this.blockPool[blockCount] ??= { wx: 0, wy: 0, angle: 0, size: 0, blockIdx: 0 };
        blk.wx = px[j]! + (px[j + 1]! - px[j]!) * t;
        blk.wy = py[j]! + (py[j + 1]! - py[j]!) * t;
        blk.angle = Math.atan2(py[j]! - py[j + 1]!, px[j]! - px[j + 1]!);
        blk.size = curSize;
        blk.blockIdx = bIdx;
        blockCount++;
      }

      // Adaptive tight step based on current tapered size so there are ZERO gaps anywhere
      const step = Math.max(3.5, curSize * 0.40);
      curD += step;
      bIdx++;
    }

    // Render from tail to head (so forward body and head draw cleanly on top)
    this.ensureBackgrounds();
    const sprites = this.blockSprites!;
    const glows = this.boostGlows!;
    const boosting = pl.boostVis;
    const nowMs = performance.now();
    // Palette INDICES per link (strings can't pick a sprite unambiguously).
    const palIdx = unpackColors(pl.colorIdx);
    const nPal = palIdx.length || 1;
    // Pattern variant per block (patternIdx is server-validated mod NUM_PATTERNS):
    //   0 solid · 1 stripes · 2 tail-fade · 3 spots · 4 dark bands (pairs) · 5 ink accents (every 4th)
    const pat = pl.patternIdx % 6;
    const variantFor = (blockIdx: number): number => {
      switch (pat) {
        case 3:
          return blockIdx % 2 === 0 ? 3 : 0;
        case 4:
          return Math.floor(blockIdx / 2) % 2 === 0 ? 4 : 0;
        case 5:
          return blockIdx % 4 === 0 ? 5 : 0;
        default:
          return pat; // 0, 1, 2 use their dedicated sprite for every block
      }
    };
    for (let b = blockCount - 1; b >= 0; b--) {
      const blk = this.blockPool[b]!;
      const scx = sx(blk.wx);
      const scy = sy(blk.wy);
      // Sprite stamp: gradient face + ink border + bevel + AO baked into ONE
      // drawImage. Scales with taper (k2), rotates to the segment tangent —
      // cheaper AND richer than the old 8-op vector block.
      const ci = palIdx[((blk.blockIdx % nPal) + nPal) % nPal] ?? 0;
      const vrow = sprites[variantFor(blk.blockIdx)] ?? sprites[0]!;
      const spr = vrow[ci] ?? vrow[0]!;
      const k2 = blk.size / 72;
      ctx.save();
      ctx.translate(scx, scy);
      ctx.rotate(blk.angle);
      // BOOST GLOW: additive bloom in THIS block's own chain color — the
      // whole snake lights up while boosting. Only paid while boosting.
      if (boosting) {
        const gr = k2 * 96 * 0.95;
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.62 + 0.22 * Math.sin(nowMs * 0.01 + b * 0.9);
        ctx.drawImage(glows[ci]!, -gr, -gr, gr * 2, gr * 2);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(spr, -48 * k2, -48 * k2, 96 * k2, 96 * k2);
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
    const headColor = this.colorsFor(pl)[0]!;

    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(pl.a);

    // Boost glow behind the head (matches the body bloom, own chain color).
    if (pl.boostVis && this.boostGlows) {
      const idx = Math.max(0, unpackColors(pl.colorIdx)[0] ?? 0);
      const gs = this.boostGlows[idx % this.boostGlows.length]!;
      const gr = headSize * 1.15;
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.7 + 0.2 * Math.sin(performance.now() * 0.01);
      ctx.drawImage(gs, -gr, -gr, gr * 2, gr * 2);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    }

    // 1. Clean Head Main Block
    ctx.fillStyle = headColor;
    ctx.beginPath();
    ctx.roundRect(-halfHead, -halfHead, headSize, headSize, cornerR);
    ctx.fill();

    // 1b. Top highlight — same lit-from-above treatment as body blocks.
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.beginPath();
    ctx.roundRect(-halfHead + 2.5 * zoom, -halfHead + 2.5 * zoom, headSize - 5 * zoom, Math.max(2, 3.5 * zoom), 2);
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

    // 4. Fresh-spawn shield shimmer (server flag — display only)
    if (pl.shield) {
      const pulse = 0.55 + 0.35 * Math.sin(performance.now() * 0.006);
      ctx.save();
      ctx.translate(hx, hy);
      ctx.rotate(pl.a);
      ctx.strokeStyle = `rgba(255, 248, 231, ${pulse.toFixed(3)})`;
      ctx.lineWidth = Math.max(2, 3 * zoom);
      ctx.beginPath();
      ctx.roundRect(
        -halfHead - 5 * zoom,
        -halfHead - 5 * zoom,
        headSize + 10 * zoom,
        headSize + 10 * zoom,
        cornerR + 4 * zoom,
      );
      ctx.stroke();
      ctx.restore();
    }

    // 5. Crown on #1 Leader
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
