import { Renderer } from "./render";
import { GameState } from "./state";
import { Net } from "./net";
import { Input } from "./input";
import { UI, KillFeedEntry } from "./ui";
import { audio } from "./audio";

const ui = new UI();
const state = new GameState();
const input = new Input();
const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new Renderer(canvas);
input.attach(canvas);

const DBG =
  new URLSearchParams(location.search).has("dbg") &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "::1");
if (DBG) (window as unknown as Record<string, unknown>).__state = state;
if (DBG) (window as unknown as Record<string, unknown>).__r = renderer;
if (DBG) (window as unknown as Record<string, unknown>).__frameProf = [];

const MOBILE = () =>
  window.matchMedia("(any-pointer: coarse)").matches || navigator.maxTouchPoints > 0;
const PORTRAIT = () => window.matchMedia("(orientation: portrait)").matches;

function updateRotateHint(): void {
  ui.toggleRotate(joined && MOBILE() && PORTRAIT());
}
window.addEventListener("orientationchange", updateRotateHint);
window.addEventListener("resize", updateRotateHint);

function lockLandscape(): void {
  try {
    const o = screen.orientation as unknown as { lock?: (o: string) => Promise<unknown> };
    if (o.lock) void o.lock("landscape").catch(() => { /* orientation lock unavailable */ });
  } catch {
    /* unsupported */
  }
}

document.addEventListener("contextmenu", (e) => e.preventDefault());

const wsProto = location.protocol === "https:" ? "wss" : "ws";
const WS_URL = `${wsProto}://${location.host}/ws`;

// Own bundle id in production ("assets/index-XXXX.js"); the server echoes the
// id it is serving in the handshake. A mismatch means this tab is running
// stale code (cached before a rebuild) — prompt a reload instead of letting
// the player fight invisible old bugs.
const BUILD_ID = import.meta.env.PROD
  ? (new URL(import.meta.url).pathname.match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? "")
  : "";
let staleShown = false;
function showStaleBanner(): void {
  if (staleShown) return;
  staleShown = true;
  const div = document.createElement("div");
  div.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:999;display:flex;align-items:center;" +
    "justify-content:center;gap:12px;padding:10px 16px;background:#FFD93D;color:#141414;" +
    "font:900 14px 'Segoe UI',Arial,sans-serif;box-shadow:0 2px 0 #141414;";
  const txt = document.createElement("span");
  txt.textContent = "New game version available — reload to get the fixes";
  const btn = document.createElement("button");
  btn.textContent = "Reload";
  btn.style.cssText =
    "background:#141414;color:#FFD93D;border:none;border-radius:8px;padding:6px 16px;" +
    "font:900 13px 'Segoe UI',Arial,sans-serif;cursor:pointer;";
  btn.addEventListener("click", () => location.reload());
  div.append(txt, btn);
  document.body.appendChild(div);
}

if ("serviceWorker" in navigator && !import.meta.env.DEV) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* sw unavailable */ });
}

let curAngle = 0;
const TURN_RATE = 7.5; // rad/s max steering speed — snake-like curved turns
let joined = false;
let hasInput = false;
let lastInputSend = 0;
let lastT = performance.now();

const net = new Net(
  WS_URL,
  (msg) => handleMessage(msg),
  () => {
    ui.setServerStatus("server: connected");
    if (joined) sendJoin();
  },
  () => {
    joined = false;
    state.alive = false;
    if (ui.el("menu").classList.contains("hidden")) {
      ui.showConnLost();
    } else {
      ui.setServerStatus("server: offline");
    }
  },
);

function viewRadius(): number {
  // World half-diagonal at the zoom floor (0.64) — the widest the camera
  // ever gets. The server clamps this to a safe max anyway.
  const MIN_ZOOM = 0.64;
  return Math.round(Math.hypot(window.innerWidth, window.innerHeight) / 2 / MIN_ZOOM);
}

function sendJoin(): void {
  const prefs = ui.prefs;
  ui.hideDeath();
  ui.hideConnLost();
  ui.hideJoining();
  ui.showHud();
  net.send({ t: "join", n: prefs.name, c: prefs.color, p: prefs.pattern, v: viewRadius() });
}

ui.setServerStatus(`server: connecting to ${WS_URL}`);
ui.buildMenu();
ui.attachBoost(input);
net.connect();

let wantsGame = false;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !wantsGame || net.open) return;
  joined = true;
  net.connect();
});

ui.setOnPlay(() => {
  joined = true;
  wantsGame = true;
  ui.hideMenu();
  ui.showJoining("joining the arena…");
  lockLandscape();
  updateRotateHint();
  if (net.open) {
    sendJoin();
  } else {
    net.connect();
  }
});

document.getElementById("respawn")!.addEventListener("click", sendJoin);
document.getElementById("reconnect")!.addEventListener("click", () => {
  joined = true;
  net.connect();
});

const soundBtn = document.getElementById("soundToggle");
if (soundBtn) {
  soundBtn.addEventListener("click", () => {
    const on = audio.toggle();
    soundBtn.textContent = on ? "🔊 SFX" : "🔇 SFX";
  });
}

// ---------- back to lobby (Esc key or optional button) ----------
const backBtn = document.getElementById("backBtn");
const backMenu = document.getElementById("backMenu");
const backWrap = document.getElementById("backWrap");
const backToLobbyBtn = document.getElementById("backToLobby");

if (backBtn && backMenu && backWrap) {
  backBtn.addEventListener("click", () => {
    if (window.matchMedia("(pointer: fine)").matches) {
      backToLobby();
      return;
    }
    const open = backMenu.classList.toggle("hidden") === false;
    backBtn.setAttribute("aria-expanded", String(open));
  });

  document.addEventListener("click", (e) => {
    if (!backMenu.classList.contains("hidden") && !backWrap.contains(e.target as Node)) {
      backMenu.classList.add("hidden");
      backBtn.setAttribute("aria-expanded", "false");
    }
  });
}

if (backToLobbyBtn) {
  backToLobbyBtn.addEventListener("click", backToLobby);
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && joined) {
    backToLobby();
  }
});

function backToLobby(): void {
  joined = false;
  wantsGame = false;
  hasInput = false;
  curAngle = 0;
  lastInputSend = 0;
  input.boostBtn = false;
  input.boostKey = false;
  input.mouseHeld = false;
  input.joystickActive = false;
  input.joyDX = 0;
  input.joyDY = 0;
  state.reset();
  ui.resetHud();
  ui.hideDeath();
  ui.hideConnLost();
  ui.hideJoining();
  ui.showMenu();
  updateRotateHint();
  net.close();
}

function handleMessage(msg: Record<string, unknown>): void {
  switch (msg.t) {
    case "hi": {
      state.myId = msg.id as number;
      state.tickRate = msg.tick as number;
      state.halfW = (msg.w as number[])[0] ?? 900;
      state.halfH = (msg.w as number[])[1] ?? 900;
      joined = true;
      ui.hideJoining();
      ui.showHud();
      const srv = msg.v as string;
      if (BUILD_ID && srv && srv !== BUILD_ID) showStaleBanner();
      break;
    }
    case "foods":
      state.applyFullFood(msg.f as unknown[]);
      break;
    case "f": {
      const removed = (msg.r as number[]) ?? [];
      const self = state.getSelf();
      if (removed.length && self) {
        for (const id of removed) {
          const f = state.food.get(id);
          if (f && Math.hypot(f[0] - self.x, f[1] - self.y) < self.thick * 1.5) {
            audio.playEat();
            break;
          }
        }
      }
      state.applyFoodEvents(msg);
      break;
    }
    case "s":
      state.applyState(msg);
      break;
    case "b":
      state.applyBody(msg);
      break;
    case "df":
      state.applyDeaths((msg.d as unknown[]) ?? []);
      break;
    case "lb":
      state.leaderboard = msg.l as Array<[number, string, number, number, number]>;
      break;
    case "kf": {
      const entries: KillFeedEntry[] = ((msg.k as unknown[]) ?? []).map((e) => {
        const r = e as [number, string | null, string, number, number, number];
        return {
          kid: r[0],
          killer: r[1],
          victim: r[2],
          wall: r[3] === 1,
          kc: r[4],
          vc: r[5],
        };
      });
      const mine = entries.filter((e) => e.kid === state.myId);
      if (mine.length > 0) {
        audio.playKill();
      }
      ui.pushKillfeed(mine);
      break;
    }
    case "pong": {
      const n = msg.n as number;
      if (Number.isFinite(n)) state.ping = Date.now() - n;
      break;
    }
    case "dead": {
      state.dead = msg.st as { kills: number; timeMs: number; maxLen: number; rank: number };
      state.alive = false;
      joined = false;
      audio.playDeath();
      ui.showDeath(state.dead);
      break;
    }
  }
}

window.addEventListener("resize", () => {
  renderer.resize();
  // Re-report the viewport radius so the server interest radius follows
  // the display (debounced — zoom is unchanged by resize events).
  if (joined && Date.now() - lastViewSent > 500) {
    lastViewSent = Date.now();
    net.send({ t: "view", r: viewRadius() });
  }
});
let lastViewSent = 0;
renderer.resize();

let wasBoosting = false;

function frame(now: number): void {
  const dt = Math.min((now - lastT) / 1000, 0.1);
  lastT = now;

  const ft0 = performance.now();
  state.update(dt);
  const ft1 = performance.now();

  if (state.alive) {
    const rotateBlocked = !ui.el("rotateHint").classList.contains("hidden");
    if (rotateBlocked) {
      hasInput = false;
    } else {
      const self = state.getSelf();
      if (self) {
        // Boost sound tracking
        const isBoost = input.boosting && self.len > 60;
        if (isBoost !== wasBoosting) {
          wasBoosting = isBoost;
          if (wasBoosting) audio.startBoost();
          else audio.stopBoost();
        }

        const ang = input.getAngle(canvas.clientWidth / 2, canvas.clientHeight / 2);
        if (ang !== null) {
          if (!hasInput) {
            hasInput = true;
            curAngle = ang;
          } else {
            let d = ang - curAngle;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;

            // Dynamic turn rate: small snakes turn sharply, giant snakes turn wider
            const turnFalloff = 800;
            const f = Math.min(1, Math.max(0, self.len / turnFalloff));
            const maxTurnRate = 6.0 - (6.0 - 2.8) * f;
            const max = maxTurnRate * dt;
            curAngle += Math.max(-max, Math.min(max, d));
          }
        }

        if (hasInput && now - lastInputSend >= 33) {
          lastInputSend = now;
          net.send({ t: "input", a: Math.round(curAngle * 1000) / 1000, b: input.boosting });
        }
        ui.setScore(self.len, self.kills);
      }
    }
  } else if (wasBoosting) {
    wasBoosting = false;
    audio.stopBoost();
  }

  renderer.draw(state, dt);
  const ft2 = performance.now();
  ui.updateJoystick(input);
  ui.drawMinimap(state);
  ui.updateLeaderboard(state.leaderboard, state.myId);
  if (state.ping > 0) ui.setPing(state.ping);
  const ft3 = performance.now();
  if (DBG) {
    const rec = (window as unknown as Record<string, unknown>).__frameProf as number[] | undefined;
    if (rec) rec.push(ft1 - ft0, ft2 - ft1, ft3 - ft2);
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
