import { GameState, DeadStats } from "./state";
import { baseColor, packColors, unpackColors, shade, INK, PALETTE } from "./patterns";
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
const PREVIEW_W = 480;
const PREVIEW_H = 160;
const MINIMAP_SIZE = 104;
const CHAIN_MAX = 8;

/** Human-readable palette names for tooltips / a11y. */
const COLOR_NAMES = [
  "VOLT YELLOW", "MAGMA ORANGE", "ABYSS CYAN", "ACID LIME",
  "BUBBLEGUM", "VOID VIOLET", "REEF TEAL", "ALARM RED",
  "CORAL", "LAVENDER", "AMBER GOLD", "GHOST WHITE",
] as const;

const PATTERN_DESCS = [
  "Clean flat faces",
  "Twin racing stripes",
  "Head-bright tail fade",
  "Spotted hunter",
  "Paired dark bands",
  "Black-ops accents",
] as const;

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

  /** Pattern picker: 6 cards with live head-color previews + descriptions. */
  private renderPatternRow(): void {
    const host = document.getElementById("patternRow");
    if (!host || host.dataset.built === "1") return;
    host.dataset.built = "1";
    PATTERNS.forEach((label, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pat-pill" + (this.prefs.pattern === i ? " active" : "");
      btn.title = `${label} — ${PATTERN_DESCS[i] ?? ""}`;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", this.prefs.pattern === i ? "true" : "false");
      btn.setAttribute("aria-label", `${label} pattern`);
      const cv = document.createElement("canvas");
      cv.width = 56;
      cv.height = 26;
      cv.className = "pat-preview";
      btn.appendChild(cv);
      const span = document.createElement("span");
      span.textContent = label;
      btn.appendChild(span);
      btn.addEventListener("click", () => {
        this.prefs.pattern = i;
        this.savePrefs();
        audio.playTick(560 + i * 40);
        host.querySelectorAll(".pat-pill").forEach((b) => {
          b.classList.remove("active");
          b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("active");
        btn.setAttribute("aria-checked", "true");
        this.syncSnakeCard();
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
      const c = cv as HTMLCanvasElement;
      // Match the CSS card size; keep backing store 2x for retina.
      const W = 56;
      const H = 26;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (c.width !== W * dpr) {
        c.width = W * dpr;
        c.height = H * dpr;
        c.style.width = `${W}px`;
        c.style.height = `${H}px`;
      }
      const g = c.getContext("2d")!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      for (let k = 0; k < 4; k++) {
        let col = k % 2 === 0 ? headCol : linkCol;
        if (i === 4 && Math.floor(k / 2) % 2 === 0) col = shade(col, -0.3);
        if (i === 5 && k % 4 === 0) col = shade(headCol, -0.78);
        g.fillStyle = col;
        g.beginPath();
        g.roundRect(k * 14 + 1, 4, 12, 18, 4);
        g.fill();
        g.strokeStyle = INK;
        g.lineWidth = 1.5;
        g.stroke();
      }
      if (i === 1) {
        g.fillStyle = "rgba(20,20,20,0.35)";
        g.fillRect(15, 5, 3, 16);
        g.fillRect(39, 5, 3, 16);
      }
      if (i === 3) {
        g.fillStyle = "rgba(20,20,20,0.4)";
        g.beginPath();
        g.roundRect(16, 9, 6, 8, 2);
        g.roundRect(44, 9, 6, 8, 2);
        g.fill();
      }
      if (i === 2) {
        // fade: bright head chip → dark tail chip
        const grad = g.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, "rgba(255,255,255,0.35)");
        grad.addColorStop(1, "rgba(0,0,0,0.35)");
        g.fillStyle = grad;
        g.fillRect(1, 4, W - 2, 18);
      }
    });
  }


  setOnPlay(fn: (p: Prefs) => void): void {
    this.onPlay = fn;
  }

  private isInitialHeadSelection = true;
  /** Which chain link the next swatch tap paints. null = append-mode (+ slot). */
  private selectedLink: number | null = null;

  /** Keep the nickname avatar dot in sync with the head color + name. */
  private syncAvatar(): void {
    const av = document.getElementById("nameAvatar");
    if (!av) return;
    const headCol = baseColor(this.prefs.colors[0] ?? 0);
    av.style.background = headCol;
    const nameVal = (document.getElementById("name") as HTMLInputElement | null)?.value.trim();
    av.textContent = (nameVal?.[0] ?? "?").toUpperCase();
  }

  /** Home snake card: live dots summary of YOUR chain + pattern. */
  private syncSnakeCard(): void {
    const dots = document.getElementById("snakeCardDots");
    const sub = document.getElementById("snakeCardSub");
    if (dots) {
      dots.innerHTML = "";
      this.prefs.colors.forEach((c, i) => {
        const d = document.createElement("i");
        if (i === 0) d.className = "head";
        d.style.background = baseColor(c);
        dots.appendChild(d);
      });
    }
    if (sub) {
      const n = this.prefs.colors.length;
      const pat = PATTERNS[this.prefs.pattern] ?? "SOLID";
      sub.textContent = n === 1 ? `HEAD ONLY · ${pat}` : `${n} LINKS · ${pat}`;
    }
  }

  /** View switching: clean home <-> dedicated snake studio. */
  showForge(): void {
    document.getElementById("homeView")?.classList.add("hidden");
    document.getElementById("forgeView")?.classList.remove("hidden");
    this.startPreviewAnimation();
    audio.playTick(660);
  }

  showHome(): void {
    document.getElementById("forgeView")?.classList.add("hidden");
    document.getElementById("homeView")?.classList.remove("hidden");
    this.syncSnakeCard();
    audio.playTick(520);
  }

  /** Shared PLAY submit (home PLAY + studio PLAY use the same path).
      Touch-portrait phones get the landscape gate first (once per session). */
  private submitPlay(): void {
    const nameInput = this.el("name") as HTMLInputElement;
    const name = nameInput.value.trim();
    if (!name) {
      // If they tapped PLAY from the studio, bring them home to the name
      // field instead of stranding them on the error.
      this.showHome();
      this.el("name").focus();
      this.flashNameInvalid();
      return;
    }
    this.prefs.name = name;
    this.savePrefs();
    if (this.needsLandscapeGate()) {
      this.gatePending = true;
      this.showLandscapeGate();
      return;
    }
    this.onPlay(this.prefs);
  }

  // ---- Landscape gate (portrait landing -> landscape arena) ---------------

  private gatePending = false;
  private static readonly GATE_KEY = "blocks.landscapeNudge";

  private isCoarseTouch(): boolean {
    return window.matchMedia("(pointer: coarse)").matches;
  }

  private isPortrait(): boolean {
    return window.matchMedia("(orientation: portrait)").matches;
  }

  /** True when we should nudge: touch phone, portrait, not yet dismissed.
      `?nogate=1` opts out (automation harnesses, power users) — same
      precedent as the `?dbg` flag in main.ts. */
  private needsLandscapeGate(): boolean {
    try {
      if (new URLSearchParams(location.search).has("nogate")) return false;
    } catch {
      /* URL unavailable — fall through to the normal checks */
    }
    if (!this.isCoarseTouch() || !this.isPortrait()) return false;
    try {
      if (sessionStorage.getItem(UI.GATE_KEY) === "1") return false;
    } catch {
      /* storage unavailable — nag every time rather than never */
    }
    return true;
  }

  private showLandscapeGate(): void {
    document.getElementById("landscapeGate")?.classList.remove("hidden");
    audio.playTick(440);
  }

  private hideLandscapeGate(): void {
    document.getElementById("landscapeGate")?.classList.add("hidden");
  }

  isLandscapeGateOpen(): boolean {
    return !(document.getElementById("landscapeGate")?.classList.contains("hidden") ?? true);
  }

  /** User rotated into landscape with the gate open — drop them straight in. */
  private autoProceedOnLandscape(): void {
    if (!this.gatePending || !this.isLandscapeGateOpen()) return;
    if (this.isPortrait()) return;
    this.proceedPendingJoin(false);
  }

  /** Resolve the pending join: remember the choice, close the gate, play. */
  private proceedPendingJoin(remember: boolean): void {
    if (remember) {
      try {
        sessionStorage.setItem(UI.GATE_KEY, "1");
      } catch {
        /* storage unavailable */
      }
    }
    this.gatePending = false;
    this.hideLandscapeGate();
    this.onPlay(this.prefs);
  }

  private wireLandscapeGate(): void {
    document.getElementById("gatePlayAnyway")?.addEventListener("click", () => {
      // Portrait anyway — don't nag again this session.
      this.proceedPendingJoin(true);
    });
    document.getElementById("gateBack")?.addEventListener("click", () => {
      this.gatePending = false;
      this.hideLandscapeGate();
    });
    // Rotating with the gate open auto-joins (the magic path).
    window.addEventListener("orientationchange", () => {
      // orientationchange fires before the layout flips — defer one frame.
      window.setTimeout(() => this.autoProceedOnLandscape(), 120);
    });
    window.addEventListener("resize", () => this.autoProceedOnLandscape());
  }

  /** Paint swatch selected/in-use states from the current chain. */
  private refreshSwatches(): void {
    const host = document.getElementById("swatches");
    if (!host) return;
    const counts = new Map<number, number>();
    for (const c of this.prefs.colors) counts.set(c, (counts.get(c) ?? 0) + 1);
    host.querySelectorAll(".swatch").forEach((el) => {
      const idx = Number((el as HTMLElement).dataset.ci ?? -1);
      const n = counts.get(idx) ?? 0;
      el.classList.toggle("in-use", n > 0);
      if (n > 0) el.setAttribute("data-count", String(n));
      else el.removeAttribute("data-count");
      const sel =
        this.selectedLink !== null
          ? this.prefs.colors[this.selectedLink] === idx
          : false;
      el.classList.toggle("selected", sel);
    });
  }

  buildMenu(): void {
    const nameInput = this.el("name") as HTMLInputElement;
    nameInput.value = this.prefs.name;
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.el("play").click();
      }
    });
    nameInput.addEventListener("input", () => this.syncAvatar());

    // REDO Button (reset whole chain) + UNDO / SHUFFLE chain actions.
    const resetBtn = document.getElementById("resetChainBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        this.prefs.colors = [this.prefs.colors[0] ?? 0];
        this.isInitialHeadSelection = true;
        this.selectedLink = null;
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

    // Build 12 Color Swatches with names + a11y roles.
    const swatches = this.el("swatches");
    swatches.innerHTML = "";
    PALETTE.forEach((c, i) => {
      const d = document.createElement("button");
      d.type = "button";
      d.className = "swatch";
      d.style.background = c;
      d.dataset.ci = String(i);
      d.title = COLOR_NAMES[i] ?? `Color ${i + 1}`;
      d.setAttribute("role", "option");
      d.setAttribute("aria-label", `Paint selected link ${COLOR_NAMES[i] ?? i + 1}`);
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
    this.syncAvatar();
    this.syncSnakeCard();
    this.startPreviewAnimation();
    this.attachPreviewPointer();
    this.buildMenuBackdrop();
    this.attachDeckParallax();

    // Home <-> studio navigation.
    document.getElementById("customizeBtn")?.addEventListener("click", () => this.showForge());
    document.getElementById("forgeBackBtn")?.addEventListener("click", () => this.showHome());
    this.wireLandscapeGate();

    this.el("play").addEventListener("click", () => this.submitPlay());
    document.getElementById("forgePlay")?.addEventListener("click", () => this.submitPlay());
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
      // First tap sets the head color, then auto-advance to append-mode.
      this.prefs.colors[0] = colorIdx;
      this.isInitialHeadSelection = false;
      this.selectedLink = null;
    } else if (this.selectedLink !== null && this.selectedLink < this.prefs.colors.length) {
      // Paint the selected link in place (the real "edit my chain" flow).
      this.prefs.colors[this.selectedLink] = colorIdx;
      // Advance to the next link so rapid taps paint down the chain.
      this.selectedLink =
        this.selectedLink + 1 < this.prefs.colors.length ? this.selectedLink + 1 : null;
    } else if (this.prefs.colors.length < CHAIN_MAX) {
      // Append-mode: each tap grows the chain; stay in append-mode.
      this.prefs.colors.push(colorIdx);
      this.selectedLink = null;
    } else {
      // Full chain + no selection: repaint the tail so taps always do something.
      this.prefs.colors[CHAIN_MAX - 1] = colorIdx;
      this.selectedLink = null;
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
    if (this.selectedLink !== null && this.selectedLink >= this.prefs.colors.length) {
      this.selectedLink = null;
    }
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
    this.selectedLink = null;
    this.refreshPatternPreviews();
    audio.playTick(820);
    window.setTimeout(() => audio.playTick(980), 90);
    this.savePrefs();
    this.updateChainIndicator();
    this.drawPreview();
  }

  /** Chain workbench strip: selectable links + a + grow slot. */
  private renderChainSlots(): void {
    const host = document.getElementById("chainSlots");
    if (!host) return;
    host.innerHTML = "";
    const n = this.prefs.colors.length;
    for (let i = 0; i < CHAIN_MAX; i++) {
      const s = document.createElement("button");
      s.type = "button";
      s.className = "slot";
      if (i < n) {
        const col = baseColor(this.prefs.colors[i]!);
        s.classList.add("filled");
        if (i === 0) s.classList.add("head");
        if (i === n - 1) s.classList.add("last");
        if (this.selectedLink === i) s.classList.add("selected");
        s.style.background = col;
        s.title = i === 0 ? "HEAD — tap to repaint" : `LINK ${i} — tap to repaint`;
        s.setAttribute("aria-label", i === 0 ? "Head link, select to repaint" : `Chain link ${i}, select to repaint`);
        s.setAttribute("aria-pressed", this.selectedLink === i ? "true" : "false");
        if (i === 0) s.textContent = "◉";
        const idx = i;
        s.addEventListener("click", () => {
          this.selectedLink = this.selectedLink === idx ? null : idx;
          if (this.selectedLink !== null) this.isInitialHeadSelection = false;
          audio.playTick(500 + idx * 30);
          this.updateChainIndicator();
        });
      } else {
        s.classList.add("add");
        s.textContent = "+";
        s.title = "Grow the chain";
        s.setAttribute("aria-label", "Add a new chain link");
        if (i > n) {
          (s as HTMLButtonElement).disabled = true;
          s.style.opacity = "0.35";
        } else {
          s.addEventListener("click", () => {
            // + slot: append a copy of the tail color (or head if lonely),
            // then select the new link so the next swatch paints it.
            const tail = this.prefs.colors[this.prefs.colors.length - 1] ?? 0;
            if (this.prefs.colors.length < CHAIN_MAX) {
              this.prefs.colors.push(tail);
              this.selectedLink = this.prefs.colors.length - 1;
              this.isInitialHeadSelection = false;
              audio.playTick(700);
              this.savePrefs();
              this.updateChainIndicator();
              this.drawPreview();
              this.refreshPatternPreviews();
            }
          });
        }
      }
      host.appendChild(s);
    }
  }

  private updateChainIndicator(): void {
    const el = document.getElementById("chainCount");
    if (el) {
      const n = this.prefs.colors.length;
      if (n === 1) {
        el.textContent = "HEAD ONLY · TAP A COLOR TO BEGIN";
      } else if (this.selectedLink !== null) {
        el.textContent =
          this.selectedLink === 0
            ? `EDITING HEAD · ${n}/${CHAIN_MAX} LINKS`
            : `EDITING LINK ${this.selectedLink} · ${n}/${CHAIN_MAX} LINKS`;
      } else if (n < CHAIN_MAX) {
        el.textContent = `${n}/${CHAIN_MAX} LINKS · TAP + OR A COLOR TO GROW`;
      } else {
        el.textContent = `MAX ${CHAIN_MAX} LINKS · TAP A LINK TO REPAINT`;
      }
      el.classList.remove("pop");
      void el.offsetWidth; // restart the CSS animation
      el.classList.add("pop");
    }
    this.renderChainSlots();
    this.refreshSwatches();
    this.syncAvatar();
    this.syncSnakeCard();
  }

  private previewAnimId: number = 0;
  private previewTime: number = 0;

  private startPreviewAnimation(): void {
    if (this.previewAnimId) return;
    const loop = (t: number) => {
      this.previewTime = t * 0.003;
      // The stage lives in the studio view — skip offscreen draws while the
      // player sits on clean home (battery + thermals on mobile).
      const forgeHidden = document.getElementById("forgeView")?.classList.contains("hidden") ?? false;
      if (!forgeHidden) this.drawPreview();
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

  private drawPreview(): void {
    const cv = this.canvas("preview");
    const ctx = cv.getContext("2d")!;
    const w = PREVIEW_W;
    const h = PREVIEW_H;
    ctx.clearRect(0, 0, w, h);

    const colors = this.prefs.colors;
    const n = colors.length;
    const t = this.previewTime;

    // Ambient food motes drifting behind the chain — sells "live arena".
    ctx.save();
    for (let i = 0; i < 14; i++) {
      const fx = ((i * 173.3 + t * 22 * (1 + (i % 3) * 0.3)) % (w + 40)) - 20;
      const fy = (i * 97.7) % h;
      const pulse = 0.7 + 0.3 * Math.sin(t * 2.2 + i * 1.7);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = baseColor((i * 5 + 1) % 12);
      const s = (3.2 + (i % 3)) * pulse;
      ctx.beginPath();
      ctx.roundRect(fx - s / 2, fy - s / 2, s, s, 1.5);
      ctx.fill();
    }
    ctx.restore();

    // Layout: head on the right, chain scaled to fit the taller stage.
    const cy = h / 2 + 6;
    const spacing = 40;
    const blockSize = 34;
    const headSize = 44;
    const totalW = (n - 1) * spacing + headSize;
    const fit = totalW > w - 56 ? (w - 56) / totalW : 1;
    const sp = spacing * fit;
    const bs = Math.max(16, blockSize * fit);
    const hs = Math.max(20, headSize * fit);
    const headX = Math.max(32 + hs / 2, (w - 48) / 2 + ((n - 1) * sp) / 2);

    // Selected-link marker: soft ring under the link being edited.
    const selPos = (linkIdx: number | null): { x: number; y: number } | null => {
      if (linkIdx === null || linkIdx >= n) return null;
      const k = n - 1 - linkIdx;
      return {
        x: headX - k * sp,
        y: cy + Math.sin(t * 3.4 - k * 0.55) * 13 + Math.sin(t * 0.8) * 4,
      };
    };

    // Center positions, tail (i = n-1) → head (i = 0), traveling wave.
    const posOf = (linkIdx: number): { x: number; y: number } => {
      const k = n - 1 - linkIdx; // distance behind head
      return {
        x: headX - k * sp,
        y: cy + Math.sin(t * 3.4 - k * 0.55) * 13 + Math.sin(t * 0.8) * 4,
      };
    };

    const sel = selPos(this.selectedLink);
    if (sel) {
      ctx.save();
      ctx.strokeStyle = "rgba(0, 229, 255, 0.8)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -t * 18;
      ctx.beginPath();
      ctx.arc(sel.x, sel.y, Math.max(bs, hs) * 0.78, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Connective spine behind the blocks — reads as one continuous chain.
    if (n > 1) {
      ctx.beginPath();
      const p0 = posOf(n - 1);
      ctx.moveTo(p0.x, p0.y);
      for (let i = n - 2; i >= 0; i--) {
        const p = posOf(i);
        ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = "rgba(10,13,26,0.9)";
      ctx.lineWidth = bs * 0.55;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    // Body blocks, tail → head. Rounder squircle faces.
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
      ctx.arc(mx, my, Math.max(2.5, bs * 0.13), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.translate(p.x, p.y);
      ctx.rotate(Math.sin(t * 3.4 - (n - 1 - i) * 0.55 + 0.6) * 0.07);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(-bs / 2, -bs / 2, bs, bs, bs * 0.3);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 3;
      ctx.stroke();
      // top light + bottom shade for the premium lit-face look
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.beginPath();
      ctx.roundRect(-bs / 2 + 4, -bs / 2 + 3.5, bs - 8, Math.max(3, bs * 0.16), 3);
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.26)";
      ctx.beginPath();
      ctx.roundRect(-bs / 2 + 4, bs / 2 - 3.5 - Math.max(3, bs * 0.14), bs - 8, Math.max(3, bs * 0.14), 3);
      ctx.fill();
      ctx.restore();
    }

    // Head block with glow.
    const hp = posOf(0);
    const headCol = baseColor(colors[0]!);
    ctx.save();
    ctx.shadowColor = headCol;
    ctx.shadowBlur = 24;
    ctx.fillStyle = headCol;
    ctx.beginPath();
    ctx.roundRect(hp.x - hs / 2, hp.y - hs / 2, hs, hs, hs * 0.28);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.42)";
    ctx.beginPath();
    ctx.roundRect(hp.x - hs / 2 + 5, hp.y - hs / 2 + 4.5, hs - 10, Math.max(3, hs * 0.13), 3);
    ctx.fill();

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

  /** Ambient menu layer: glow orbs + a few drifting chain links.
      Fewer, slower, dimmer than before — texture, not confetti. */
  private buildMenuBackdrop(): void {
    const host = document.querySelector(".menu-backdrop");
    if (!host || host.childElementCount > 0) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    // 3 blurred color orbs for depth
    const orbColors = ["#00E5FF", "#FF5CA8", "#B6F50E"];
    orbColors.forEach((col, i) => {
      const orb = document.createElement("div");
      orb.className = "bd-orb";
      orb.style.background = col;
      orb.style.left = `${[-8, 62, 28][i]}%`;
      orb.style.top = `${[58, -10, 30][i]}%`;
      orb.style.animationDelay = `${i * -5}s`;
      host.appendChild(orb);
    });

    // Drifting chain links (arena palette) — sparse + varied depth
    const cubeColors = ["#B6F50E", "#00E5FF", "#FF5CA8", "#FFD93D", "#7C5CFF", "#FF5722"];
    const CUBE_COUNT = 10;
    for (let i = 0; i < CUBE_COUNT; i++) {
      const c = document.createElement("div");
      c.className = "bd-cube";
      const size = 12 + Math.random() * 20;
      c.style.width = `${size}px`;
      c.style.height = `${size}px`;
      c.style.background = cubeColors[i % cubeColors.length]!;
      c.style.left = `${Math.random() * 94}%`;
      c.style.top = `${Math.random() * 90}%`;
      c.style.setProperty("--dur", `${11 + Math.random() * 10}s`);
      c.style.setProperty("--delay", `${-Math.random() * 14}s`);
      c.style.setProperty("--dx", `${(Math.random() - 0.5) * 70}px`);
      c.style.setProperty("--dy", `${-24 - Math.random() * 50}px`);
      c.style.setProperty("--rot", Math.random() < 0.5 ? "-360deg" : "360deg");
      c.style.setProperty("--spin", `${16 + Math.random() * 20}s`);
      if (i % 3 === 0) c.style.filter = "blur(1.4px)"; // depth variety
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
    // Lobby always lands on clean home (never strands on the studio page).
    document.getElementById("forgeView")?.classList.add("hidden");
    document.getElementById("homeView")?.classList.remove("hidden");
    this.gatePending = false;
    this.hideLandscapeGate();
    this.startPreviewAnimation();
    this.syncSnakeCard();
  }

  hideMenu(): void {
    this.el("menu").classList.add("hidden");
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

  /** Mode picker: CLASSIC vs COLLAPSE battle-map cards. Persisted
      and sent with every join so respawn stays in the same arena. */
  private renderModeRow(): void {
    const host = document.getElementById("modeRow");
    if (!host || host.dataset.built === "1") return;
    host.dataset.built = "1";
    const modes: Array<["classic" | "br", string, string, string]> = [
      ["classic", "🗺️", "CLASSIC", "Endless map · pure slither warfare"],
      ["br", "🌀", "COLLAPSE", "Shrinking wall · last chain wins"],
    ];
    for (const [val, ico, label, desc] of modes) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mode-card" + (this.prefs.mode === val ? " active" : "");
      b.title = desc;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", this.prefs.mode === val ? "true" : "false");
      const icon = document.createElement("span");
      icon.className = "mode-ico";
      icon.textContent = ico;
      const txt = document.createElement("span");
      txt.className = "mode-txt";
      const nm = document.createElement("span");
      nm.className = "mode-name";
      nm.textContent = label;
      const ds = document.createElement("span");
      ds.className = "mode-desc";
      ds.textContent = desc;
      txt.append(nm, ds);
      b.append(icon, txt);
      b.addEventListener("click", () => {
        if (this.prefs.mode !== val) {
          this.prefs.mode = val;
          this.savePrefs();
          audio.playTick(600);
        }
        host.querySelectorAll(".mode-card").forEach((x) => {
          x.classList.remove("active");
          x.setAttribute("aria-checked", "false");
        });
        b.classList.add("active");
        b.setAttribute("aria-checked", "true");
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
    let html = "";
    for (let i = 0; i < top3.length; i++) {
      const [id, name, len, , colorIdx] = top3[i]!;
      const you = id === myId ? " you" : "";
      html += `
        <div class="board-row${you}">
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

    // Translucent glass: faint dark tint keeps dots readable while the LIVE
    // arena shows through — you can spot snakes approaching from this angle.
    ctx.save();
    ctx.fillStyle = "rgba(5, 10, 22, 0.32)";
    ctx.beginPath();
    ctx.arc(cx, cy, radarR, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 248, 231, 0.28)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radarR, 0, Math.PI * 2);
    ctx.stroke();

    // Faint crosshairs
    ctx.strokeStyle = "rgba(255, 248, 231, 0.10)";
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

    // Other snakes (square pips — colored core, thin dark edge for contrast)
    for (const pl of state.players.values()) {
      if (pl.id === state.myId) continue;
      const x = mapX(pl.x);
      const y = mapY(pl.y);
      const col = baseColor(pl.colorIdx);
      ctx.fillStyle = col;
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 3, y - 3, 6, 6);
    }

    // Player self marker (bright gold square pip with outline)
    const me = state.getSelf();
    if (me) {
      const mx = mapX(me.x);
      const my = mapY(me.y);
      ctx.fillStyle = "#FFD93D";
      ctx.fillRect(mx - 4, my - 4, 9, 9);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(mx - 4, my - 4, 9, 9);
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
