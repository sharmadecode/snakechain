import { GameState, DeadStats } from "./state";
import { baseColor, packColors, unpackColors, shade, INK, CREAM, PALETTE } from "./patterns";
import { Input } from "./input";

export interface Prefs {
  name: string;
  colors: number[];
  color: number;
  pattern: number;
}

export interface KillFeedEntry {
  kid: number;
  killer: string | null;
  victim: string;
  wall: boolean;
  kc: number;
  vc: number;
}

export class UI {
  prefs: Prefs = {
    name: "",
    colors: [0, 1, 4, 2, 3], // 1 to 8 colors in the repeating chain
    color: 0,
    pattern: 0,
  };
  private onPlay: (p: Prefs) => void = () => {};
  private activeSlot = 0;
  private killfeedQueue: KillFeedEntry[] = [];

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
      }
    } catch {
      /* fresh start */
    }
    if (!this.prefs.colors || this.prefs.colors.length === 0) {
      this.prefs.colors = [0, 1, 4, 2, 3];
    }
    this.prefs.color = packColors(this.prefs.colors);
  }

  el(id: string): HTMLElement {
    const e = document.getElementById(id);
    if (!e) throw new Error(`missing element #${id}`);
    return e;
  }

  canvas(id: string): HTMLCanvasElement {
    return this.el(id) as HTMLCanvasElement;
  }

  savePrefs(): void {
    try {
      this.prefs.color = packColors(this.prefs.colors);
      localStorage.setItem("blocks.prefs", JSON.stringify(this.prefs));
    } catch {
      /* storage unavailable */
    }
  }

  setOnPlay(fn: (p: Prefs) => void): void {
    this.onPlay = fn;
  }

  private isInitialHeadSelection = true;

  buildMenu(): void {
    const nameInput = this.el("name") as HTMLInputElement;
    nameInput.value = this.prefs.name;
    nameInput.addEventListener("input", () => this.drawPreview());

    // REDO Button
    const resetBtn = document.getElementById("resetChainBtn");
    if (resetBtn) {
      resetBtn.addEventListener("click", () => {
        this.prefs.colors = [this.prefs.colors[0] ?? 0];
        this.isInitialHeadSelection = true;
        this.savePrefs();
        this.updateChainIndicator();
        this.drawPreview();
      });
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
      d.addEventListener("click", () => this.onColorTapped(i));
      swatches.appendChild(d);
    });

    this.updateChainIndicator();
    this.startPreviewAnimation();

    this.el("play").addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        nameInput.style.boxShadow = "4px 4px 0 #FF3B30";
        setTimeout(() => (nameInput.style.boxShadow = ""), 700);
        return;
      }
      this.prefs.name = name;
      this.savePrefs();
      this.onPlay(this.prefs);
    });
  }

  private onColorTapped(colorIdx: number): void {
    if (this.prefs.colors.length === 1 && this.isInitialHeadSelection) {
      // First tap sets the head color
      this.prefs.colors[0] = colorIdx;
      this.isInitialHeadSelection = false;
    } else if (this.prefs.colors.length < 8) {
      // Each subsequent tap adds a cube with that color to the snake chain
      this.prefs.colors.push(colorIdx);
    }
    this.savePrefs();
    this.updateChainIndicator();
    this.drawPreview();
  }

  private updateChainIndicator(): void {
    const el = document.getElementById("chainCount");
    if (!el) return;
    const n = this.prefs.colors.length;
    if (n === 1) {
      el.textContent = "TAP COLORS TO EXTEND CHAIN";
    } else if (n < 8) {
      el.textContent = `CHAIN LENGTH: ${n} · TAP TO ADD`;
    } else {
      el.textContent = "CHAIN READY · TAP REDO TO RESTART";
    }
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

  private drawPreview(): void {
    const cv = this.el("preview") as HTMLCanvasElement;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    const w = cv.width;
    const h = cv.height;
    ctx.clearRect(0, 0, w, h);

    const n = this.prefs.colors.length;
    const blockSize = 28;
    const halfBlock = blockSize / 2;
    const cy = h / 2;
    const spacing = 24;
    const totalW = (n - 1) * spacing + 34;
    const startX = Math.max(35, (w - totalW) / 2 + 10);
    const t = this.previewTime;

    // Draw body blocks (tail to head) with fluid sinusoidal wave motion
    for (let i = n - 1; i >= 1; i--) {
      const wave = Math.sin(t * 3.8 - i * 0.7) * 14;
      const x = startX + (n - 1 - i) * spacing;
      const y = cy + wave;
      const col = baseColor(this.prefs.colors[i]!);

      // Block Fill
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.roundRect(x - halfBlock, y - halfBlock, blockSize, blockSize, 5);
      ctx.fill();

      // Ink Outline
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.roundRect(x - halfBlock, y - halfBlock, blockSize, blockSize, 5);
      ctx.stroke();

      // Top Bevel
      ctx.fillStyle = shade(col, 0.35);
      ctx.fillRect(x - halfBlock + 2, y - halfBlock + 2, blockSize - 4, 3.5);
    }

    // Draw Head Block (Slot 0, on top)
    const headWave = Math.sin(t * 3.8) * 14;
    const headX = startX + (n - 1) * spacing;
    const headY = cy + headWave;
    const headSize = 34;
    const halfHead = headSize / 2;
    const headCol = baseColor(this.prefs.colors[0]!);

    // Head Block Fill
    ctx.fillStyle = headCol;
    ctx.beginPath();
    ctx.roundRect(headX - halfHead, headY - halfHead, headSize, headSize, 7);
    ctx.fill();

    // Ink Outline
    ctx.strokeStyle = INK;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(headX - halfHead, headY - halfHead, headSize, headSize, 7);
    ctx.stroke();

    // Googly Eyes
    const eyeSize = 11;
    const pupilSize = 5;
    for (const ey of [headY - 8, headY + 8]) {
      const ex = headX + 4;

      // Eye White Socket
      ctx.fillStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.roundRect(ex - eyeSize / 2, ey - eyeSize / 2, eyeSize, eyeSize, 3);
      ctx.fill();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(ex - eyeSize / 2, ey - eyeSize / 2, eyeSize, eyeSize, 3);
      ctx.stroke();

      // Pupil (follows wave)
      const pupilYOffset = Math.sin(t * 3) * 1.5;
      ctx.fillStyle = INK;
      ctx.fillRect(ex + 1 - pupilSize / 2, ey + pupilYOffset - pupilSize / 2, pupilSize, pupilSize);
    }
  }

  showMenu(): void {
    this.el("menu").classList.remove("hidden");
    this.el("hud").classList.add("hidden");
    this.el("joining").classList.add("hidden");
    this.el("death").classList.add("hidden");
    this.el("connLost").classList.add("hidden");
    this.startPreviewAnimation();
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

  showDeath(st: DeadStats): void {
    const mins = Math.floor(st.timeMs / 60000);
    const secs = Math.floor((st.timeMs % 60000) / 1000);
    const time = `${mins}m ${secs.toString().padStart(2, "0")}s`;

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
      <div class="stat-card"><span>MAX LENGTH</span><b>${st.maxLen}</b></div>
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
    this.lastBoardHtml = "";
    this.updateLeaderboard([], 0);
    this.lastScore = "";
    const scoreEl = document.getElementById("scoreLen");
    if (scoreEl) scoreEl.textContent = "0";
    this.killfeedQueue.length = 0;
    const kfEl = document.getElementById("killfeed");
    if (kfEl) kfEl.innerHTML = "";
  }

  showConnLost(): void {
    this.el("hud").classList.add("hidden");
    this.el("connLost").classList.remove("hidden");
  }

  hideConnLost(): void {
    this.el("connLost").classList.add("hidden");
  }

  toggleRotate(show: boolean): void {
    const el = document.getElementById("rotateHint");
    if (el) el.classList.toggle("hidden", !show);
  }

  setServerStatus(text: string): void {
    const el = document.getElementById("serverStatus");
    if (el) el.textContent = text;
  }

  setPing(_ms: number): void {
    // Ping hidden for minimal clean mobile HUD
  }

  private lastBoardHtml = "";

  updateLeaderboard(rows: Array<[number, string, number, number, number]>, myId: number): void {
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
      const el = document.getElementById("boardRows");
      if (el) el.innerHTML = html;
    }
  }

  private lastScore = "";

  updateScore(len: number, _kills = 0): void {
    const scoreStr = `${Math.round(len)}`;
    if (scoreStr === this.lastScore) return;
    this.lastScore = scoreStr;
    const el = document.getElementById("scoreLen");
    if (el) el.textContent = scoreStr;
  }

  setScore(len: number, kills = 0): void {
    this.updateScore(len, kills);
  }

  pushKillfeed(entries: KillFeedEntry[]): void {
    for (const e of entries) {
      this.pushKillFeed(e);
    }
  }

  updateJoystick(input: Input): void {
    const base = this.el("joystickBase");
    const thumb = this.el("joystickThumb");
    if (!input.joystickActive) {
      base.classList.add("hidden");
      return;
    }
    base.classList.remove("hidden");
    base.style.left = `${input.joyBaseX}px`;
    base.style.top = `${input.joyBaseY}px`;
    thumb.style.transform = `translate(calc(-50% + ${input.joyDX}px), calc(-50% + ${input.joyDY}px))`;
  }

  pushKillFeed(k: KillFeedEntry): void {
    if (k.kid === -1 && !k.victim) {
      this.el("killfeed").innerHTML = "";
      return;
    }
    this.killfeedQueue.push(k);
    if (this.killfeedQueue.length > 2) this.killfeedQueue.shift();
    const el = this.el("killfeed");
    el.innerHTML = this.killfeedQueue
      .map((e) => {
        return `<div class="kf-item">⚔️ YOU ELIMINATED <span class="v">${escapeHtml(e.victim.toUpperCase())}</span></div>`;
      })
      .join("");
    setTimeout(() => {
      const idx = this.killfeedQueue.indexOf(k);
      if (idx >= 0) {
        this.killfeedQueue.splice(idx, 1);
        this.pushKillFeed({ kid: -1, killer: null, victim: "", wall: false, kc: 0, vc: 0 });
      }
    }, 4000);
  }

  drawMinimap(state: GameState): void {
    const cv = this.canvas("minimap");
    const ctx = cv.getContext("2d")!;
    const w = cv.width;
    const h = cv.height;
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

  wireBackMenu(onLeave: () => void): void {
    const backBtn = this.el("backBtn");
    const backMenu = this.el("backMenu");
    const backWrap = this.el("backWrap");

    const toggle = (open?: boolean): void => {
      const next = typeof open === "boolean" ? open : backMenu.classList.contains("hidden");
      backMenu.classList.toggle("hidden", !next);
      backBtn.setAttribute("aria-expanded", String(next));
    };

    backBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle();
    });

    this.el("backToLobby").addEventListener("click", () => {
      toggle(false);
      onLeave();
    });

    document.addEventListener("click", (e) => {
      if (!backWrap.contains(e.target as Node)) toggle(false);
    });
  }

  wireSoundToggle(onToggle: () => boolean): void {
    const btn = this.el("soundToggle");
    btn.addEventListener("click", () => {
      const enabled = onToggle();
      btn.textContent = enabled ? "🔊 SFX ON" : "🔇 SFX OFF";
      btn.classList.toggle("muted", !enabled);
    });
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
