import { GameState, DeadStats } from "./state";
import { baseColor, packColors, unpackColors, shade, INK, CREAM, PALETTE } from "./patterns";
import { Input } from "./input";
import { audio } from "./audio";

export interface Prefs {
  name: string;
  colors: number[];
  color: number;
  pattern: number;
  /** Arena selection: "classic" (constant map) or "br" (collapse rounds). */
  mode: "classic" | "br";
  /** Persisted SFX mute state (undefined in legacy saves = on). */
  sound?: boolean;
}

export interface KillFeedEntry {
  kid: number;
  victim: string;
  wall: boolean;
}

/** Local lifetime progression (never leaves the browser — no accounts). */
export interface GameStats {
  bestLen: number;
  mostKills: number;
  games: number;
}

const STATS_KEY = "blocks.stats";

/** Pattern catalog — indices MUST match NUM_PATTERNS on the server and the
    sprite variants baked in render.ts (0..5). */
export const PATTERNS = ["SOLID", "STRIPES", "FADE", "SPOTS", "BANDS", "ACCENT"] as const;

/** Logical (design-unit) backing sizes for the DPR-aware canvases. */
const PREVIEW_W = 400;
const PREVIEW_H = 120;
const MINIMAP_SIZE = 104;
const CHAIN_MAX = 8;

export class UI {
  prefs: Prefs = {
    name: "",
    // Start with a single head block so the very first swatch tap sets the
    // head color (see onColorTapped) instead of appending to a preset chain.
    colors: [0],
    color: 0,
    pattern: 0,
    mode: "classic",
  };
  private onPlay: (p: Prefs) => void = () => {};

  // Cached element refs — looked up once, not every frame.
  private joystickBase: HTMLElement;
  private joystickThumb: HTMLElement;
  private rotateHintEl: HTMLElement;
  private killfeedEl: HTMLElement;
  private boardRowsEl: HTMLElement;
  private scoreEl: HTMLElement;
  private pingEl: HTMLElement;

  constructor() {
    try {
      const raw = localStorage.getItem("blocks.prefs");
      if (raw) {
        const p = JSON.parse(raw) as Partial<Prefs>;
        if (typeof p.name === "string") this.prefs.name = p.name.slice(0, 14);
        if (Array.isArray(p.colors) && p.colors.length >= 1) {
          this.prefs.colors = p.colors.slice(0, 8).map((c) => (Number(c) % 12 + 12) % 12);
        } else if (typeof p.color === "number") {
          this.prefs.colors = unpackColors(p.color);
        }
        if (typeof p.sound === "boolean") this.prefs.sound = p.sound;
        if (p.mode === "classic" || p.mode === "br") this.prefs.mode = p.mode;
      }
    } catch {
      /* fresh start */
    }
    this.loadStats();
    if (!this.prefs.colors || this.prefs.colors.length === 0) {
      this.prefs.colors = [0];
    }
    this.prefs.color = packColors(this.prefs.colors);

    this.joystickBase = document.getElementById("joystickBase")!;
    this.joystickThumb = document.getElementById("joystickThumb")!;
    this.rotateHintEl = document.getElementById("rotateHint")!;
    this.killfeedEl = document.getElementById("killfeed")!;
    this.boardRowsEl = document.getElementById("boardRows")!;
    this.scoreEl = document.getElementById("scoreLen")!;
    this.pingEl = document.getElementById("pingBadge")!;

    this.setupPreviewCanvas();
    this.setupMinimapCanvas();
  }

  el(id: string): HTMLElement {
    const e = document.getElementById(id);
    if (!e) throw new Error(`missing element #${id}`);
    return e;
  }

  canvas(id: string): HTMLCanvasElement {
    return this.el(id) as HTMLCanvasElement;
  }

  /** Scale a decorative canvas backing store by devicePixelRatio so it stays
      sharp on retina, while drawing keeps using fixed logical coordinates. */
  private setupHiDpi(cv: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  private setupPreviewCanvas(): void {
    this.setupHiDpi(this.canvas("preview"), PREVIEW_W, PREVIEW_H);
  }

  private setupMinimapCanvas(): void {
    this.setupHiDpi(this.canvas("minimap"), MINIMAP_SIZE, MINIMAP_SIZE);
  }

  savePrefs(): void {
    try {
      this.prefs.color = packColors(this.prefs.colors);
      localStorage.setItem("blocks.prefs", JSON.stringify(this.prefs));
    } catch {
      /* storage unavailable */
    }
  }

  // ---- Lifetime progression (personal bests) -----------------------------

  private stats: GameStats = { bestLen: 0, mostKills: 0, games: 0 };

  private loadStats(): void {
    try {
      const raw = localStorage.getItem(STATS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<GameStats>;
      const num = (v: unknown): number =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
      this.stats = { bestLen: num(s.bestLen), mostKills: num(s.mostKills), games: num(s.games) };
    } catch {
      /* fresh start */
    }
  }

  private saveStats(): void {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(this.stats));
    } catch {
      /* storage unavailable */
    }
  }

  /** Merge a finished game into lifetime stats. Returns which records broke
      (plus the updated best), so the death screen can celebrate them. */
  recordDeath(st: DeadStats): { newBest: boolean; newKills: boolean; bestLen: number } {
    this.stats.games++;
    const newBest = st.maxLen > this.stats.bestLen && st.maxLen > 0;
    const newKills = st.kills > this.stats.mostKills && st.kills > 0;
    if (newBest) this.stats.bestLen = st.maxLen;
    if (newKills) this.stats.mostKills = st.kills;
    this.saveStats();
    return { newBest, newKills, bestLen: this.stats.bestLen };
  }

  /** Menu strip: BEST len · TOP KILLS · GAMES (hidden when no games yet). */
  private renderMenuStats(): void {
    const el = document.getElementById("menuStats");
    if (!el) return;
    if (this.stats.games === 0) {
      el.textContent = "";
      return;
    }
    el.textContent =
      `PERSONAL BEST ${this.stats.bestLen} · TOP KILLS ${this.stats.mostKills} · GAMES ${this.stats.games}`;
  }

  /** Pattern picker: one pill per pattern, mini canvas preview drawn in the
      current head color so the row re-renders when the chain changes. */
  private renderPatternRow(): void {
    const host = document.getElementById("patternRow");
    if (!host || host.dataset.built === "1") return;
    host.dataset.built = "1";
    PATTERNS.forEach((label, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pat-pill" + (this.prefs.pattern === i ? " active" : "");
      btn.title = `${label} pattern`;
      const cv = document.createElement("canvas");
      cv.width = 40;
      cv.height = 20;
      cv.className = "pat-preview";
      btn.appendChild(cv);
      const span = document.createElement("span");
      span.textContent = label;
      btn.appendChild(span);
      btn.addEventListener("click", () => {
        this.prefs.pattern = i;
        this.savePrefs();
        audio.playTick(560 + i * 40);
        host.querySelectorAll(".pat-pill").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
      });
      host.appendChild(btn);
    });
    this.refreshPatternPreviews();
  }

  /** Redraw the little pattern previews whenever the head color changes. */
  refreshPatternPreviews(): void {
    const host = document.getElementById("patternRow");
    if (!host) return;
    const headCol = baseColor(this.prefs.colors[0] ?? 0);
    const linkCol = baseColor(this.prefs.colors[1] ?? this.prefs.colors[0] ?? 0);
    host.querySelectorAll("canvas.pat-preview").forEach((cv, i) => {
      const g = (cv as HTMLCanvasElement).getContext("2d")!;
      g.clearRect(0, 0, 40, 20);
      for (let k = 0; k < 4; k++) {
        let col = k % 2 === 0 ? headCol : linkCol;
        if (i === 4 && Math.floor(k / 2) % 2 === 0) col = shade(col, -0.3);
        if (i === 5 && k % 4 === 0) col = shade(headCol, -0.78);
        g.fillStyle = col;
        g.fillRect(k * 10 + 1, 3, 8, 14);
        g.strokeStyle = INK;
        g.lineWidth = 1.5;
        g.strokeRect(k * 10 + 1, 3, 8, 14);
      }
      if (i === 1) {
        g.fillStyle = "rgba(20,20,20,0.35)";
        g.fillRect(11, 4, 2, 12);
        g.fillRect(29, 4, 2, 12);
      }
      if (i === 3) {
        g.fillStyle = "rgba(20,20,20,0.4)";
        g.fillRect(13, 7, 4, 6);
        g.fillRect(33, 7, 4, 6);
      }
    });
  }


  setOnPlay(fn: (p: Prefs) => void): void {
    this.onPlay = fn;
  }

  private isInitialHeadSelection = true;

  buildMenu(): void {
    const nameInput = this.el("name") as HTMLInputElement;
    nameInput.value = this.prefs.name;
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.el("play").click();
      }
    });

    // REDO Button (reset whole chain) + UNDO / SHUFFLE chain actions.
    const resetBtn = document.getElementById("resetChainBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        this.prefs.colors = [this.prefs.colors[0] ?? 0];
        this.isInitialHeadSelection = true;
        this.savePrefs();
        audio.playTick(300);
        this.updateChainIndicator();
        this.drawPreview();
        this.refreshPatternPreviews();
      });
    }
    const undoBtn = document.getElementById("undoChainBtn");
    if (undoBtn) {
      undoBtn.addEventListener("click", () => this.removeLastLink());
    }
    const shuffleBtn = document.getElementById("shuffleChainBtn");
    if (shuffleBtn) {
      shuffleBtn.addEventListener("click", () => this.shuffleChain());
    }

    // Build 12 Color Swatches
    const swatches = this.el("swatches");
    swatches.innerHTML = "";
    PALETTE.forEach((c, i) => {
      const d = document.createElement("button");
      d.type = "button";
      d.className = "swatch";
      d.style.background = c;
      d.setAttribute("aria-label", `color ${i + 1}`);
      d.addEventListener("click", () => {
        // One-shot bounce on the tapped swatch (restart-safe).
        d.classList.remove("pop");
        void d.offsetWidth;
        d.classList.add("pop");
        this.onColorTapped(i);
      });
      swatches.appendChild(d);
    });

    this.updateChainIndicator();
    this.renderPatternRow();
    this.renderModeRow();
    this.renderMenuStats();
    this.startPreviewAnimation();
    this.attachPreviewPointer();
    this.startOnlineCounter();
    this.buildMenuBackdrop();
    this.attachDeckParallax();

    this.el("play").addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        this.flashNameInvalid();
        return;
      }
      this.prefs.name = name;
      this.savePrefs();
      this.onPlay(this.prefs);
    });
  }

  /** Inline nickname-required feedback: shake the field and show the hint. */
  flashNameInvalid(): void {    const nameInput = this.el("name") as HTMLInputElement;
    nameInput.classList.remove("flash-invalid");
    void nameInput.offsetWidth; // restart the CSS animation
    nameInput.classList.add("flash-invalid");
    const msg = document.getElementById("nameError");
    if (msg) msg.classList.remove("hidden");
    setTimeout(() => msg?.classList.add("hidden"), 2000);
  }

  private onColorTapped(colorIdx: number): void {
    if (this.prefs.colors.length === 1 && this.isInitialHeadSelection) {
      // First tap sets the head color
      this.prefs.colors[0] = colorIdx;
      this.isInitialHeadSelection = false;
    } else if (this.prefs.colors.length < CHAIN_MAX) {
      // Each subsequent tap adds a cube with that color to the snake chain
      this.prefs.colors.push(colorIdx);
    }
    audio.playTick(560 + this.prefs.colors.length * 40);
    this.savePrefs();
    this.updateChainIndicator();
    this.drawPreview();
    // Pattern previews tint from the head color — keep them in sync.
    this.refreshPatternPreviews();
  }

  /** Pop the last chain link (head can never be removed). */
  private removeLastLink(): void {
    if (this.prefs.colors.length <= 1) {
      audio.playTick(240);
      return;
    }
    this.prefs.colors.pop();
    audio.playTick(340);
    this.savePrefs();
    this.updateChainIndicator();
    this.drawPreview();
  }

  /** Roll a fresh random chain (3–8 links, no immediate repeats). */
  private shuffleChain(): void {
    const len = Math.min(CHAIN_MAX, 3 + Math.floor(Math.random() * 6));
    const chain: number[] = [Math.floor(Math.random() * PALETTE.length)];
    while (chain.length < len) {
      const c = Math.floor(Math.random() * PALETTE.length);
      if (c !== chain[chain.length - 1]) chain.push(c);
    }
    this.prefs.colors = chain;
    this.isInitialHeadSelection = false;
    this.refreshPatternPreviews();
    audio.playTick(820);
    window.setTimeout(() => audio.playTick(980), 90);
    this.savePrefs();
    this.updateChainIndicator();
    this.drawPreview();
  }

  /** Chain-slot strip under the stage: filled links + dashed empty slots. */
  private renderChainSlots(): void {
    const host = document.getElementById("chainSlots");
    if (!host) return;
    host.innerHTML = "";
    const n = this.prefs.colors.length;
    for (let i = 0; i < CHAIN_MAX; i++) {
      const s = document.createElement("span");
      s.className = "slot";
      if (i < n) {
        const col = baseColor(this.prefs.colors[i]!);
        s.classList.add("filled");
        if (i === 0) s.classList.add("head");
        if (i === n - 1) s.classList.add("last");
        s.style.background = col;
        s.title = i === 0 ? "HEAD" : `LINK ${i}`;
        if (i === 0) s.textContent = "H";
      } else {
        s.classList.add("add");
        s.textContent = "+";
      }
      host.appendChild(s);
    }
  }

  private updateChainIndicator(): void {
    const el = document.getElementById("chainCount");
    if (!el) return;
    const n = this.prefs.colors.length;
    if (n === 1) {
      el.textContent = "TAP COLORS TO EXTEND CHAIN";
    } else if (n < CHAIN_MAX) {
      el.textContent = `CHAIN LENGTH: ${n} · TAP TO ADD`;
    } else {
      el.textContent = "CHAIN READY · MAX LINKS";
    }
    el.classList.remove("pop");
    void el.offsetWidth; // restart the CSS animation
    el.classList.add("pop");
    this.renderChainSlots();
  }

  private previewAnimId: number = 0;
  private previewTime: number = 0;

  private startPreviewAnimation(): void {
    if (this.previewAnimId) return;
    const loop = (t: number) => {
      this.previewTime = t * 0.003;
      this.drawPreview();
      const menuEl = document.getElementById("menu");
      if (menuEl && !menuEl.classList.contains("hidden")) {
        this.previewAnimId = requestAnimationFrame(loop);
      } else {
        this.previewAnimId = 0;
      }
    };
    this.previewAnimId = requestAnimationFrame(loop);
  }

  /** Pointer position over the preview stage (logical units) — pupils track it. */
  private previewPointer = { x: PREVIEW_W * 0.75, y: PREVIEW_H / 2 };

  private attachPreviewPointer(): void {
    const cv = this.canvas("preview");
    cv.addEventListener("pointermove", (e) => {
      const r = cv.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      this.previewPointer.x = ((e.clientX - r.left) / r.width) * PREVIEW_W;
      this.previewPointer.y = ((e.clientY - r.top) / r.height) * PREVIEW_H;
    });
  }

  /** Live "IN ARENA" counter fed by the server's own /health endpoint.
      Runs ONLY while the menu is visible — a permanently-running poller
      would (a) waste requests during gameplay and (b) keep an idle Render
      free instance awake forever whenever any tab is merely open. */
  private onlineTimer: number | null = null;

  private startOnlineCounter(): void {
    const el = document.getElementById("onlineCount");
    if (!el || this.onlineTimer !== null) return;
    const update = async (): Promise<void> => {
      try {
        const res = await fetch("/health", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { alive?: unknown; humans?: unknown };
        const n = typeof j.alive === "number" ? j.alive : undefined;
        if (typeof n === "number") {
          el.textContent = `${n} IN ARENA`;
          el.classList.toggle("hot", n > 0);
        }
      } catch {
        /* offline — pill keeps its last value */
      }
    };
    void update();
    this.onlineTimer = window.setInterval(update, 15000);
  }

  private stopOnlineCounter(): void {
    if (this.onlineTimer !== null) {
      clearInterval(this.onlineTimer);
      this.onlineTimer = null;
    }
  }

  private drawPreview(): void {
    const cv = this.canvas("preview");
    const ctx = cv.getContext("2d")!;
    const w = PREVIEW_W;
    const h = PREVIEW_H;
    ctx.clearRect(0, 0, w, h);

    const colors = this.prefs.colors;
    const n = colors.length;
    const t = this.previewTime;

    // Layout: head on the right, chain scaled to fit the stage.
    const cy = h / 2 + 4;
    const spacing = 34;
    const blockSize = 30;
    const headSize = 38;
    const totalW = (n - 1) * spacing + headSize;
    const fit = totalW > w - 48 ? (w - 48) / totalW : 1;
    const sp = spacing * fit;
    const bs = Math.max(14, blockSize * fit);
    const hs = Math.max(18, headSize * fit);
    const headX = Math.max(28 + hs / 2, (w - 40) / 2 + ((n - 1) * sp) / 2);

    // Center positions, tail (i = n-1) → head (i = 0), traveling wave.
    const posOf = (linkIdx: number): { x: number; y: number } => {
      const k = n - 1 - linkIdx; // distance behind head
      return {
        x: headX - k * sp,
        y: cy + Math.sin(t * 3.4 - k * 0.55) * 12 + Math.sin(t * 0.8) * 4,
      };
    };

    // Connective spine behind the blocks — reads as one continuous chain.
    if (n > 1) {
      ctx.beginPath();
      const p0 = posOf(n - 1);
      ctx.moveTo(p0.x, p0.y);
      for (let i = n - 2; i >= 0; i--) {
        const p = posOf(i);
        ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = "rgba(16,19,31,0.9)";
      ctx.lineWidth = bs * 0.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    // Body blocks, tail → head.
    for (let i = n - 1; i >= 1; i--) {
      const p = posOf(i);
      const col = baseColor(colors[i]!);
      ctx.save();
      // Chain-link pin between this block and its neighbour toward the head.
      const pn = posOf(i - 1);
      const mx = (p.x + pn.x) / 2;
      const my = (p.y + pn.y) / 2;
      ctx.fillStyle = "#FFF8E7";
      ctx.beginPath();
      ctx.arc(mx, my, Math.max(2.5, bs * 0.14), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.translate(p.x, p.y);
      ctx.rotate(Math.sin(t * 3.4 - (n - 1 - i) * 0.55 + 0.6) * 0.08);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(-bs / 2, -bs / 2, bs, bs, 7);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = shade(col, 0.35);
      ctx.fillRect(-bs / 2 + 3, -bs / 2 + 3, bs - 6, Math.max(3, bs * 0.16));
      ctx.restore();
    }

    // Head block with glow.
    const hp = posOf(0);
    const headCol = baseColor(colors[0]!);
    ctx.save();
    ctx.shadowColor = headCol;
    ctx.shadowBlur = 20;
    ctx.fillStyle = headCol;
    ctx.beginPath();
    ctx.roundRect(hp.x - hs / 2, hp.y - hs / 2, hs, hs, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.fillStyle = shade(headCol, 0.35);
    ctx.fillRect(hp.x - hs / 2 + 4, hp.y - hs / 2 + 4, hs - 8, Math.max(3, hs * 0.14));

    // Googly eyes tracking the pointer, with a periodic blink.
    const blink = t % 3.1 < 0.09 ? 0.15 : 1;
    const eye = hs * 0.34;
    const dxp = this.previewPointer.x - hp.x;
    const dyp = this.previewPointer.y - hp.y;
    const dl = Math.hypot(dxp, dyp) || 1;
    const pxOff = (dxp / dl) * Math.min(2.4, dl * 0.05);
    const pyOff = (dyp / dl) * Math.min(2.4, dl * 0.05);
    for (const eyOff of [-hs * 0.24, hs * 0.24]) {
      const exX = hp.x + hs * 0.16;
      const exY = hp.y + eyOff;
      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.roundRect(exX - eye / 2, exY - (eye * blink) / 2, eye, eye * blink, 4);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.arc(exX + pxOff + eye * 0.12, exY + pyOff, (eye * 0.26) * blink + 0.001, 0, Math.PI * 2);
      ctx.fill();
    }

    // Occasional tongue flick ahead of the head.
    if (t % 2.6 < 0.16) {
      ctx.strokeStyle = "#FF3B30";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      const bx = hp.x + hs / 2;
      const tip = bx + 11;
      ctx.beginPath();
      ctx.moveTo(bx, hp.y);
      ctx.lineTo(tip, hp.y);
      ctx.moveTo(tip, hp.y);
      ctx.lineTo(tip + 4, hp.y - 3.5);
      ctx.moveTo(tip, hp.y);
      ctx.lineTo(tip + 4, hp.y + 3.5);
      ctx.stroke();
    }

    // Growth affordance when the chain is a lonely head.
    if (n === 1) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = "rgba(255,248,231,0.5)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(hp.x + hs / 2 + 10, hp.y);
      ctx.lineTo(hp.x + hs / 2 + 46, hp.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(255,248,231,0.65)";
      ctx.font = "900 11px 'Outfit', system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("TAP A COLOR", Math.min(w - 92, hp.x + hs / 2 + 52), hp.y + 4);
    }

    ctx.restore();
  }

  /** Ambient menu layer: soft glow orbs + drifting "food cube" motes in the
      arena palette. Injected once; runs only while the menu is visible
      (display:none pauses it) and disabled entirely under reduced motion. */
  private buildMenuBackdrop(): void {
    const host = document.querySelector(".menu-backdrop");
    if (!host || host.childElementCount > 0) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    // 3 blurred color orbs for depth
    const orbColors = ["#00C2D1", "#FF5CA8", "#B6F50E"];
    orbColors.forEach((col, i) => {
      const orb = document.createElement("div");
      orb.className = "bd-orb";
      orb.style.background = col;
      orb.style.left = `${[-8, 62, 28][i]}%`;
      orb.style.top = `${[58, -10, 30][i]}%`;
      orb.style.animationDelay = `${i * -5}s`;
      host.appendChild(orb);
    });

    // Drifting food cubes (arena palette, ink borders)
    const cubeColors = ["#FFD93D", "#FF5722", "#00C2D1", "#A8E10C", "#FF5CA8", "#7C5CFF"];
    const CUBE_COUNT = 14;
    for (let i = 0; i < CUBE_COUNT; i++) {
      const c = document.createElement("div");
      c.className = "bd-cube";
      const size = 10 + Math.random() * 22;
      c.style.width = `${size}px`;
      c.style.height = `${size}px`;
      c.style.background = cubeColors[i % cubeColors.length]!;
      c.style.left = `${Math.random() * 96}%`;
      c.style.top = `${Math.random() * 92}%`;
      c.style.setProperty("--dur", `${9 + Math.random() * 9}s`);
      c.style.setProperty("--delay", `${-Math.random() * 12}s`);
      c.style.setProperty("--dx", `${(Math.random() - 0.5) * 90}px`);
      c.style.setProperty("--dy", `${-30 - Math.random() * 60}px`);
      c.style.setProperty("--rot", Math.random() < 0.5 ? "-360deg" : "360deg");
      c.style.setProperty("--spin", `${14 + Math.random() * 18}s`);
      if (i % 3 === 0) c.style.filter = "blur(1.2px)"; // depth variety
      host.appendChild(c);
    }
  }

  /** Subtle pointer parallax tilt on the deck card (fine pointers only). */
  private attachDeckParallax(): void {
    const deck = document.querySelector(".arcade-deck") as HTMLElement | null;
    if (!deck) return;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine || reduced) return;

    let raf = 0;
    let targetRX = 0;
    let targetRY = 0;
    let curRX = 0;
    let curRY = 0;
    const apply = () => {
      raf = 0;
      curRX += (targetRX - curRX) * 0.12;
      curRY += (targetRY - curRY) * 0.12;
      deck.style.transform = `perspective(1100px) rotateX(${curRX.toFixed(2)}deg) rotateY(${curRY.toFixed(2)}deg)`;
      if (Math.abs(curRX - targetRX) > 0.01 || Math.abs(curRY - targetRY) > 0.01) {
        raf = requestAnimationFrame(apply);
      }
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    document.getElementById("menu")!.addEventListener("pointermove", (e) => {
      const r = deck.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      targetRY = nx * 4; // max ~4deg
      targetRX = -ny * 3;
      kick();
    });
    document.getElementById("menu")!.addEventListener("pointerleave", () => {
      targetRX = 0;
      targetRY = 0;
      kick();
    });
  }

  showMenu(): void {
    this.el("menu").classList.remove("hidden");
    this.el("hud").classList.add("hidden");
    this.el("joining").classList.add("hidden");
    this.el("death").classList.add("hidden");
    this.el("connLost").classList.add("hidden");
    this.startPreviewAnimation();
    this.startOnlineCounter(); // idempotent — guard prevents duplicates
    this.renderMenuStats();
  }

  hideMenu(): void {
    this.el("menu").classList.add("hidden");
    this.stopOnlineCounter();
  }

  showJoining(note: string): void {
    this.el("joining").classList.remove("hidden");
    this.el("joinNote").textContent = note;
  }

  hideJoining(): void {
    this.el("joining").classList.add("hidden");
  }

  showHud(): void {
    this.el("hud").classList.remove("hidden");
  }

  /** Mode picker: CLASSIC (constant map) vs COLLAPSE (BR rounds). Persisted
      and sent with every join so respawn stays in the same arena. */
  private renderModeRow(): void {
    const host = document.getElementById("modeRow");
    if (!host || host.dataset.built === "1") return;
    host.dataset.built = "1";
    const modes: Array<["classic" | "br", string, string]> = [
      ["classic", "CLASSIC", "Constant slither-io style map"],
      ["br", "COLLAPSE", "Battle-royale shrinking wall rounds"],
    ];
    for (const [val, label, title] of modes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pat-pill" + (this.prefs.mode === val ? " active" : "");
      b.title = title;
      const dot = document.createElement("span");
      dot.textContent = val === "br" ? "🌀" : "🗺️";
      b.appendChild(dot);
      const span = document.createElement("span");
      span.textContent = label;
      b.appendChild(span);
      b.addEventListener("click", () => {
        if (this.prefs.mode !== val) {
          this.prefs.mode = val;
          this.savePrefs();
          audio.playTick(600);
        }
        host.querySelectorAll(".pat-pill").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
      });
      host.appendChild(b);
    }
  }

  /** BR collapse champion banner — top-center, auto-fades (textContent only). */
  private champTimer: number | null = null;

  showChampion(name: string): void {
    const el = document.getElementById("champBanner");
    if (!el) return;
    el.textContent = `👑 ${name} CONQUERED THE COLLAPSE`;
    el.classList.remove("hidden");
    if (this.champTimer !== null) clearTimeout(this.champTimer);
    this.champTimer = window.setTimeout(() => {
      el.classList.add("hidden");
      this.champTimer = null;
    }, 4500);
  }

  showDeath(
    st: DeadStats,
    pb?: { newBest: boolean; newKills: boolean; bestLen: number },
    spectating = false,
  ): void {
    // Spectate mode: lighten the overlay so the killer-cam action stays visible.
    this.el("death").classList.toggle("spectating", spectating);
    const mins = Math.floor(st.timeMs / 60000);
    const secs = Math.floor((st.timeMs % 60000) / 1000);
    const time = `${mins}m ${secs.toString().padStart(2, "0")}s`;

    // Personal-best celebration banner (recordDeath computed the flags).
    const pbEl = document.getElementById("pbBanner");
    if (pbEl) {
      if (pb?.newBest) {
        pbEl.textContent = `🏆 NEW PERSONAL BEST LENGTH — ${st.maxLen}`;
        pbEl.classList.remove("hidden");
      } else if (pb?.newKills) {
        pbEl.textContent = `⚔️ NEW MOST-KILLS RECORD — ${st.kills}`;
        pbEl.classList.remove("hidden");
      } else {
        pbEl.classList.add("hidden");
      }
    }

    let killerText = "ELIMINATED IN COMBAT";
    if (st.wall) {
      killerText = "CRASHED INTO ARENA BOUNDARY";
    } else if (st.killerName) {
      killerText = `ELIMINATED BY <b>${escapeHtml(st.killerName.toUpperCase())}</b>`;
    }
    this.el("deathKiller").innerHTML = killerText;

    this.el("deathStats").innerHTML = `
      <div class="stat-card"><span>TIME ALIVE</span><b>${time}</b></div>
      <div class="stat-card"><span>TOTAL KILLS</span><b>${st.kills}</b></div>
      <div class="stat-card"><span>MAX LENGTH${this.stats.bestLen ? ` · PB ${this.stats.bestLen}` : ""}</span><b>${st.maxLen}</b></div>
      <div class="stat-card"><span>FINAL RANK</span><b>#${st.rank}</b></div>
    `;
    this.el("death").classList.remove("hidden");
    this.el("hud").classList.add("hidden");
  }

  hideDeath(): void {
    this.el("death").classList.add("hidden");
    this.el("hud").classList.remove("hidden");
  }

  resetHud(): void {
    this.lastLbRef = null;
    this.boardRowsEl.innerHTML = "";
    this.lastScore = "";
    this.scoreEl.textContent = "0";
    this.killfeedEl.innerHTML = "";
    this.lastPingShown = -1;
    this.pingEl.textContent = "";
  }

  /** Connection-lost panel; `msg` lets callers distinguish "arena full"
      (close code 1013 / joinErr full) from a genuine network drop. */
  showConnLost(msg = "CONNECTION LOST"): void {
    const title = document.getElementById("connLostTitle");
    if (title) title.textContent = msg;
    this.el("hud").classList.add("hidden");
    this.el("connLost").classList.remove("hidden");
  }

  hideConnLost(): void {
    this.el("connLost").classList.add("hidden");
  }

  toggleRotate(show: boolean): void {
    this.rotateHintEl.classList.toggle("hidden", !show);
  }

  /** Reflects connection health on the menu's LIVE pill (dot color). */
  setServerStatus(text: string): void {
    const pill = document.getElementById("livePill");
    if (!pill) return;
    pill.classList.toggle("st-offline", text.includes("offline"));
    pill.classList.toggle("st-connecting", text.includes("connecting"));
    pill.title = text;
  }

  private lastPingShown = -1;

  setPing(ms: number): void {
    // Throttled: the value changes every 5s (ping interval), but the frame
    // loop calls this 60x/s.
    const v = Math.min(999, Math.round(ms));
    if (v === this.lastPingShown) return;
    this.lastPingShown = v;
    this.pingEl.textContent = `${v}ms`;
    this.pingEl.classList.toggle("bad", v >= 200);
  }

  private lastLbRef: Array<[number, string, number, number, number]> | null = null;
  private lastLbMyId = 0;
  private lastBoardHtml = "";

  updateLeaderboard(rows: Array<[number, string, number, number, number]>, myId: number): void {
    // Rows only change when a new `lb` message lands (or on reset) — skip
    // the string build entirely on the other ~59 frames per second.
    if (rows === this.lastLbRef && myId === this.lastLbMyId) return;
    this.lastLbRef = rows;
    this.lastLbMyId = myId;
    const top3 = rows.slice(0, 3);
    const medals = ["🥇", "🥈", "🥉"];
    let html = "";
    for (let i = 0; i < top3.length; i++) {
      const [id, name, len, , colorIdx] = top3[i]!;
      const you = id === myId ? " you" : "";
      html += `
        <div class="board-row${you}">
          <span class="rn">${medals[i] ?? `#${i + 1}`}</span>
          <span class="dot" style="background:${baseColor(colorIdx ?? 0)}"></span>
          <span class="nm">${escapeHtml(name)}</span>
          <span class="ln">${Math.round(len)}</span>
        </div>`;
    }
    if (html !== this.lastBoardHtml) {
      this.lastBoardHtml = html;
      this.boardRowsEl.innerHTML = html;
    }
  }

  private lastScore = "";

  /** HUD length readout, change-gated (kills live in the leaderboard only). */
  setScore(len: number): void {
    const scoreStr = `${Math.round(len)}`;
    if (scoreStr === this.lastScore) return;
    this.lastScore = scoreStr;
    this.scoreEl.textContent = scoreStr;
  }

  /** Append one entry as its own DOM node so expiry can remove just that
      node — a full innerHTML wipe would also kill newer entries and replay
      the popIn animation on survivors. */
  pushKillfeed(entries: KillFeedEntry[]): void {
    for (const e of entries) {
      const div = document.createElement("div");
      div.className = "kf-item";
      div.innerHTML = `⚔️ YOU ELIMINATED <span class="v">${escapeHtml(e.victim.toUpperCase())}</span>`;
      while (this.killfeedEl.children.length >= 2) {
        this.killfeedEl.firstElementChild?.remove();
      }
      this.killfeedEl.appendChild(div);
      setTimeout(() => div.remove(), 4000);
    }
  }

  updateJoystick(input: Input): void {
    if (!input.joystickActive) {
      this.joystickBase.classList.add("hidden");
      return;
    }
    this.joystickBase.classList.remove("hidden");
    this.joystickBase.style.left = `${input.joyBaseX}px`;
    this.joystickBase.style.top = `${input.joyBaseY}px`;
    this.joystickThumb.style.transform = `translate(calc(-50% + ${input.joyDX}px), calc(-50% + ${input.joyDY}px))`;
  }

  drawMinimap(state: GameState): void {
    const cv = this.canvas("minimap");
    const ctx = cv.getContext("2d")!;
    const w = MINIMAP_SIZE;
    const h = MINIMAP_SIZE;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const radarR = w / 2 - 4;

    // Neo-Brutalism Cream radar with dark ink ring
    ctx.save();
    ctx.fillStyle = CREAM;
    ctx.beginPath();
    ctx.arc(cx, cy, radarR, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radarR, 0, Math.PI * 2);
    ctx.stroke();

    // Radar crosshairs
    ctx.strokeStyle = "rgba(20, 20, 20, 0.15)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, 4);
    ctx.lineTo(cx, h - 4);
    ctx.moveTo(4, cy);
    ctx.lineTo(w - 4, cy);
    ctx.stroke();

    const radScale = radarR / Math.max(1, state.halfW);
    const mapX = (wx: number) => cx + wx * radScale;
    const mapY = (wy: number) => cy + wy * radScale;

    // Other snakes (square pips)
    for (const pl of state.players.values()) {
      if (pl.id === state.myId) continue;
      const x = mapX(pl.x);
      const y = mapY(pl.y);
      const col = baseColor(pl.colorIdx);
      ctx.fillStyle = INK;
      ctx.fillRect(x - 2.5, y - 2.5, 6, 6);
      ctx.fillStyle = col;
      ctx.fillRect(x - 3, y - 3, 5, 5);
    }

    // Player self marker (High-contrast bright yellow/gold square pip with outline)
    const me = state.getSelf();
    if (me) {
      const mx = mapX(me.x);
      const my = mapY(me.y);
      ctx.fillStyle = INK;
      ctx.fillRect(mx - 5, my - 5, 12, 12);
      ctx.fillStyle = "#FFD93D";
      ctx.fillRect(mx - 4, my - 4, 10, 10);
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(mx - 4, my - 4, 10, 10);
    }
    ctx.restore();
  }

  attachBoost(input: Input): void {
    const btn = this.el("boostBtn");
    const setBoost = (on: boolean) => {
      input.boostBtn = on;
      btn.classList.toggle("active", on);
    };
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setBoost(true);
    });
    window.addEventListener("pointerup", () => setBoost(false));
    window.addEventListener("pointercancel", () => setBoost(false));
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}
