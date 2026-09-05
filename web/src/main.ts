// CSS is bundled+hashed through Vite (was an unhashed <link> that the
// service worker cached cache-first — stale styles survived every deploy).
import "../styles.css";
import { Renderer } from "./render";
import { GameState } from "./state";
import { Net } from "./net";
import { Input } from "./input";
import { UI, KillFeedEntry } from "./ui";
import { audio } from "./audio";

// roundRect landed in Safari 16 / older Androids lack it entirely — without
// this polyfill every snake block draw throws and the arena renders blank.
if (typeof CanvasRenderingContext2D !== "undefined" && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (
    x: number, y: number, w: number, h: number,
    r: number | number[] | DOMPointInit | (number | DOMPointInit)[] = 0,
  ): void {
    const rad = typeof r === "number"
      ? Math.min(r, w / 2, h / 2)
      : Array.isArray(r)
        ? Math.min(typeof r[0] === "number" ? (r[0] as number) : ((r[0] as DOMPointInit)?.x ?? 0), w / 2, h / 2)
        : Math.min(r.x ?? 0, w / 2, h / 2);
    this.moveTo(x + rad, y);
    this.lineTo(x + w - rad, y);
    this.arcTo(x + w, y, x + w, y + rad, rad);
    this.lineTo(x + w, y + h - rad);
    this.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    this.lineTo(x + rad, y + h);
    this.arcTo(x, y + h, x, y + h - rad, rad);
    this.lineTo(x, y + rad);
    this.arcTo(x, y, x + rad, y, rad);
    this.closePath();
  };
}

const ui = new UI();
const state = new GameState();
const input = new Input();
const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new Renderer(canvas);
input.attach(canvas);
// Per-frame HUD visibility checks resolve these ONCE — never getElementById
// inside the rAF loop.
const hudEl = document.getElementById("hud");
const rotateHintEl = document.getElementById("rotateHint");

const DBG =
  new URLSearchParams(location.search).has("dbg") &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "::1");
if (DBG) (window as unknown as Record<string, unknown>).__state = state;
if (DBG) (window as unknown as Record<string, unknown>).__r = renderer;

const MOBILE = () => window.matchMedia("(pointer: coarse)").matches;
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

// Block the context menu only during gameplay (mouse steering); keep it
// available on the menu so right-click paste works in the nickname field.
document.addEventListener("contextmenu", (e) => {
  if (joined) e.preventDefault();
});

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
let joined = false;
let hasInput = false;
let lastInputSend = 0;
let lastT = performance.now();

// Join-ack watchdog (UX-05): a silently ignored or rejected join must never
// strand the player on the "ENTERING ARENA…" spinner.
let joinAcked = false;
let joinAckTimer: number | null = null;

// Auto-retry (cold-start resilience): a Render free-tier cold start can take
// 30–60s, far past net.ts's 8s connect timeout. Instead of stranding the
// player on CONNECTION LOST, quietly retry a few times with backoff. Any
// explicit user action or successful join resets the counter.
const RETRY_DELAYS_MS = [2000, 5000, 10000];
let retryCount = 0;
function scheduleRetry(): void {
  const attempt = ++retryCount;
  ui.showJoining(`reconnecting… ${attempt}/${RETRY_DELAYS_MS.length}`);
  window.setTimeout(() => {
    if (!wantsGame || net.open) return;
    net.connect();
  }, RETRY_DELAYS_MS[attempt - 1]!);
}

function clearJoinAck(): void {
  joinAcked = false;
  if (joinAckTimer !== null) {
    clearTimeout(joinAckTimer);
    joinAckTimer = null;
  }
}

// Adaptive-quality watchdog state (RD-05): EMA of frame time with hysteresis.
let emaDtMs = 16.7;
let hotFrames = 0;
let coolFrames = 0;
let qualityLow = false;

// Production frame-error surfacing (FE-03): the loop must survive throws,
// but repeated failures must not be invisible.
let errStreak = 0;
let lastErrLogAt = 0;

const net = new Net(
  WS_URL,
  (msg) => handleMessage(msg),
  () => {
    ui.setServerStatus("server: connected");
    if (joined) sendJoin();
  },
  (code) => {
    clearJoinAck();
    joined = false;
    state.alive = false;
    state.spectateId = 0;
    // Cold-start auto-retry: transient failures while the player still wants
    // to play get up to 3 quiet retries before the manual RECONNECT screen.
    // Arena-full (1013) and clean closes are NOT retried.
    if (code !== 1013 && code !== 1000 && wantsGame && retryCount < RETRY_DELAYS_MS.length) {
      scheduleRetry();
      return;
    }
    // 1013 = server/arena full: a retry-soon message beats a generic drop.
    const title = code === 1013 ? "ARENA FULL — TRY AGAIN SOON" : "CONNECTION LOST";
    if (ui.el("menu").classList.contains("hidden")) {
      ui.hideJoining();
      ui.showConnLost(title);
    } else {
      ui.setServerStatus("server: offline");
    }
  },
);

function viewRadius(): number {
  // World half-diagonal at the zoom floor (0.62, matching the renderer's
  // camera clamp) — the widest the camera ever gets. The server clamps
  // this to a safe max anyway.
  const MIN_ZOOM = 0.62;
  return Math.round(Math.hypot(window.innerWidth, window.innerHeight) / 2 / MIN_ZOOM);
}

function sendJoin(): void {
  const prefs = ui.prefs;
  state.spectateId = 0; // leaving the death-cam
  ui.hideDeath();
  ui.hideConnLost();
  ui.hideJoining();
  ui.showHud();
  net.send({
    t: "join",
    n: prefs.name,
    c: prefs.color,
    p: prefs.pattern,
    v: viewRadius(),
    mo: prefs.mode, // arena routing: "classic" | "br"
  });
  // Arm the ack watchdog: if no `hi`/`joinErr` lands (rejected by an older
  // build, dropped frame), recover to the connection screen instead of
  // spinning forever. 8.5 s sits just BEHIND net.ts's 8 s CONNECT timeout so
  // a slow transport (Render free-tier cold start) fails through the normal
  // close path first — this timer only catches silent app-level ignores.
  joinAcked = false;
  if (joinAckTimer !== null) clearTimeout(joinAckTimer);
  joinAckTimer = window.setTimeout(() => {
    joinAckTimer = null;
    if (!joinAcked && joined) {
      joined = false;
      wantsGame = false;
      state.alive = false;
      ui.hideJoining();
      ui.showConnLost("CONNECTION LOST");
    }
  }, 8500);
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
document.getElementById("backBtn")?.addEventListener("click", (e) => {
  // In-game back button: returns to the lobby from ANY state (playing/dead).
  e.stopPropagation();
  backToLobby();
});
document.getElementById("reconnect")!.addEventListener("click", () => {
  joined = true;
  retryCount = 0; // explicit user action — full fresh retry budget
  joined = true;
  // A dropped match leaves ghosts of the previous world behind; start the
  // fresh socket from a clean slate (the join snapshot refills everything).
  state.reset();
  ui.resetHud();
  ui.hideConnLost();
  ui.showJoining("reconnecting…");
  net.connect();
});

const soundBtn = document.getElementById("soundToggle");
if (soundBtn) {
  // Restore the persisted mute state BEFORE first audio init so a muted
  // player never gets an AudioContext unlocked by their next click.
  audio.enabled = ui.prefs.sound !== false;
  soundBtn.textContent = audio.enabled ? "🔊" : "🔇";
  soundBtn.addEventListener("click", () => {
    const on = audio.toggle();
    ui.prefs.sound = on;
    ui.savePrefs();
    soundBtn.textContent = on ? "🔊" : "🔇";
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (joined) {
    backToLobby();
  } else if (!ui.el("death").classList.contains("hidden")) {
    // Death screen: Escape acts as RESPAWN (keyboard parity with the button).
    sendJoin();
  }
});

function backToLobby(): void {
  joined = false;
  wantsGame = false;
  hasInput = false;
  curAngle = 0;
  lastInputSend = 0;
  retryCount = 0;
  clearJoinAck();
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
      // Server-echoed turn model [MAX, MIN, FALLOFF] — prediction must
      // match authority; fall back to shipped defaults on old servers.
      const tr = msg.turn;
      if (
        Array.isArray(tr) && tr.length === 3 &&
        tr.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)
      ) {
        state.turn = tr as number[];
      }
      joined = true;
      joinAcked = true;
      retryCount = 0; // connected — restore the full retry budget
      clearJoinAck();
      ui.hideJoining();
      ui.showHud();
      const srv = msg.v as string;
      if (BUILD_ID && srv && srv !== BUILD_ID) showStaleBanner();
      break;
    }
    case "joinErr": {
      // Server refused the join (invalid name / arena full). Recover with a
      // targeted screen instead of hanging on the spinner.
      clearJoinAck();
      joined = false;
      wantsGame = false;
      state.alive = false;
      ui.hideJoining();
      if (msg.why === "full") {
        ui.showConnLost("ARENA FULL — TRY AGAIN SOON");
      } else {
        ui.showMenu();
        ui.flashNameInvalid();
      }
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
    case "lb": {
      // Defensive ingest: a malformed row must never reach the render loop.
      const rows = Array.isArray(msg.l) ? msg.l : [];
      state.leaderboard = rows.filter(
        (r): r is [number, string, number, number, number] =>
          Array.isArray(r) &&
          typeof r[1] === "string" &&
          Number.isFinite(r[2]) &&
          Number.isFinite(r[3]) &&
          Number.isFinite(r[4]),
      );
      break;
    }
    case "kf": {
      const entries: KillFeedEntry[] = ((msg.k as unknown[]) ?? []).map((e) => {
        const r = e as [number, string, string, number];
        return {
          kid: r[0],
          victim: r[2],
          wall: r[3] === 1,
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
    case "champ": {
      // BR collapse champion — server-known name, rendered via textContent.
      const n = typeof msg.n === "string" ? msg.n.slice(0, 20) : "";
      if (n) ui.showChampion(n);
      break;
    }
    case "dead": {
      const st = msg.st as Record<string, unknown> | null | undefined;
      if (!st || typeof st !== "object") break; // stay in-game rather than crash on a bad frame
      const num = (v: unknown, d: number): number =>
        typeof v === "number" && Number.isFinite(v) ? v : d;
      state.dead = {
        kills: num(st.kills, 0),
        timeMs: num(st.timeMs, 0),
        maxLen: num(st.maxLen, 0),
        rank: num(st.rank, 0),
        killerName: typeof st.killerName === "string" ? st.killerName : null,
        wall: st.wall === true,
      };
      state.alive = false;
      joined = false;
      // Stop the visibilitychange handler from auto-respawning on tab focus —
      // death is a deliberate stop; only an explicit RESPAWN rejoins.
      wantsGame = false;
      // Merge into lifetime stats BEFORE showing the screen so PB flags and
      // the menu strip are ready for either RESPAWN or ESC→lobby.
      const pb = ui.recordDeath(state.dead);
      state.spectateId = state.dead.killerId ?? 0;
      // Tell the server where to center interest while we spectate — without
      // this the killer stops streaming after ~3s (interest stayed on corpse).
      if (state.spectateId) {
        net.send({ t: "view", r: viewRadius(), tg: state.spectateId });
      }
      audio.playDeath();
      ui.showDeath(state.dead, pb, state.spectateId > 0);
      break;
    }
  }
}

let lastViewSent = 0;
window.addEventListener("resize", () => {
  renderer.resize();
  // Re-report the viewport radius so the server interest radius follows
  // the display (debounced — zoom is unchanged by resize events).
  if (joined && Date.now() - lastViewSent > 500) {
    lastViewSent = Date.now();
    net.send({ t: "view", r: viewRadius() });
  }
});
renderer.resize();

let wasBoosting = false;

function frame(now: number): void {
  // Schedule the next frame BEFORE any work: a single throw in the update or
  // draw path must never permanently kill the loop (frozen canvas, no error).
  requestAnimationFrame(frame);
  try {
    const dt = Math.min((now - lastT) / 1000, 0.1);
    lastT = now;

    // Adaptive quality (RD-05): sustained slow frames drop render DPR to 1;
    // a comfortably fast stretch restores it. Tab-return spikes (dt ≥ 90 ms)
    // are excluded from the EMA so they never trigger a downgrade.
    if (dt < 0.09) emaDtMs = emaDtMs * 0.95 + dt * 1000 * 0.05;
    if (!qualityLow) {
      if (emaDtMs > 22 && ++hotFrames > 90) {
        qualityLow = true;
        hotFrames = 0;
        coolFrames = 0;
        renderer.setQualityLevel(true);
      } else if (emaDtMs <= 22) hotFrames = 0;
    } else {
      if (emaDtMs < 12 && ++coolFrames > 420) {
        qualityLow = false;
        coolFrames = 0;
        hotFrames = 0;
        renderer.setQualityLevel(false);
      } else if (emaDtMs >= 12) coolFrames = 0;
    }

    state.update(dt);

    if (state.alive) {
      const rotateBlocked = !rotateHintEl!.classList.contains("hidden");
      if (rotateBlocked) {
        hasInput = false;
      } else {
        const self = state.getSelf();
        if (self) {
          // Boost sound tracking
          const isBoost = input.boosting && self.len > 60;
          // Exact boost state for SELF (remotes use velocity inference).
          // Server truth: boost only works above BOOST_MIN_LENGTH (45).
          self.boostVis = input.boosting && self.len > 45;
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

              // Dynamic turn rate: small snakes turn sharply, giant snakes
              // turn wider. Constants come from the server handshake
              // ([MAX, MIN, FALLOFF]) so prediction matches authority.
              const tMax = state.turn[0] ?? 6.0;
              const tMin = state.turn[1] ?? 2.8;
              const tFall = state.turn[2] ?? 800;
              const f = Math.min(1, Math.max(0, self.len / tFall));
              const maxTurnRate = tMax - (tMax - tMin) * f;
              const max = maxTurnRate * dt;
              curAngle += Math.max(-max, Math.min(max, d));
            }
          }

          if (hasInput && now - lastInputSend >= 33) {
            lastInputSend = now;
            net.send({ t: "input", a: Math.round(curAngle * 1000) / 1000, b: input.boosting });
          }
          ui.setScore(self.len);
        }
      }
    } else if (wasBoosting) {
      wasBoosting = false;
      audio.stopBoost();
    }

    renderer.draw(state, dt);
    // HUD surfaces are display:none under menu/death overlays — skip their
    // per-frame canvas draws and style writes while invisible.
    if (!hudEl!.classList.contains("hidden")) {
      ui.updateJoystick(input);
      ui.drawMinimap(state);
      if (state.ping > 0) ui.setPing(state.ping);
    }
    ui.updateLeaderboard(state.leaderboard, state.myId);
    errStreak = 0;
  } catch (err) {
    errStreak++;
    if (errStreak >= 10 && now - lastErrLogAt > 5000) {
      lastErrLogAt = now;
      errStreak = 0;
      console.error("[frame] repeated frame error", err); // visible in prod too
    }
    if (import.meta.env.DEV) console.error("[frame]", err);
  }
}
requestAnimationFrame(frame);
