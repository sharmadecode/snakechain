import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { Matchmaker } from "./matchmaker.js";
import { Session, ClientHandle } from "./session.js";
import { Player } from "./player.js";
import * as C from "./config.js";
import { normAngle } from "./vec.js";
import { CHAIN_PACKED_MAX, CHAIN_MAX_COLORS, isCanonicalChain, packChain } from "./colors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate client static assets directory.
 */
function findWebDist(): string {
  const override = process.env.WEB_DIST;
  if (override) return path.resolve(override);
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "web", "dist");
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(path.dirname(__dirname), "web", "dist");
}
const WEB_DIST = findWebDist();

const CLIENT_INDEX = path.join(WEB_DIST, "index.html");
// The web bundle hash changes on every client rebuild. Resolving it ONCE at
// boot meant the running server echoed a stale id after any rebuild — every
// fresh client then saw a permanent "new version available" banner that no
// hard refresh could clear (the server, not the browser, was stale).
// Fix: re-read only when index.html's mtime moves (one stat per join).
let CLIENT_BUILD = "";
let CLIENT_BUILD_MTIME = 0;
function clientBuild(): string {
  try {
    const mt = fs.statSync(CLIENT_INDEX).mtimeMs;
    if (mt !== CLIENT_BUILD_MTIME) {
      const html = fs.readFileSync(CLIENT_INDEX, "utf8");
      CLIENT_BUILD = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0] ?? "";
      CLIENT_BUILD_MTIME = mt;
    }
  } catch {
    /* keep last known id — a missing file must never break joins */
  }
  return CLIENT_BUILD;
}

const envInt = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

const PORT = envInt(process.env.PORT, 8787);
const MAX_PER_IP = envInt(process.env.MAX_PER_IP, C.MAX_CONNS_PER_IP);
const MAX_CONNS = envInt(process.env.MAX_CONNS, 1000);
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const HTTPS = process.env.HTTPS === "1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Hosted platforms (Render etc.) sit behind a reverse proxy: without
// TRUST_PROXY=1 every client shares the proxy's remoteAddress and
// MAX_PER_IP locks everyone out after a few connections.
if (!TRUST_PROXY && (process.env.RENDER || process.env.WEBSITE_SITE_NAME)) {
  console.warn(
    `[server] WARNING: reverse-proxy hosting detected but TRUST_PROXY is not 1 — ` +
      `every client shares the proxy IP and MAX_PER_IP=${MAX_PER_IP} will lock everyone out.`,
  );
}

const BOOT_AT = Date.now();

/**
 * Resolve the client IP for per-IP limiting.
 *
 * TRUST_PROXY=1 (REQUIRED behind Render/any reverse proxy — without it
 * every client shares the proxy's remoteAddress and MAX_PER_IP locks
 * everyone out): trust exactly ONE hop. The rightmost X-Forwarded-For
 * entry is the one our trusted edge appended; leftmost entries are
 * client-controlled and trivially spoofable.
 */
function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1]!;
    }
  }
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

const SAFE_NAME = /^[\p{L}\p{N} _\-!?.]+$/u;

interface Conn {
  ws: WebSocket;
  ip: string;
  player: Player | null;
  session: Session | null;
  handle: ClientHandle | null;
  aliveSincePing: boolean;
  lastInputAt: number;
  inputCount: number;
  joinedCount: number;
  joinWindowStart: number;
  dropped: boolean;
  msgCount: number;
  msgWindowStart: number;
}

const matchmaker = new Matchmaker();
const connsByIp = new Map<string, number>();
const connsByWs = new Map<WebSocket, Conn>();
let connCount = 0;

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "connect-src 'self' ws: wss:; img-src 'self'; font-src 'self' https://fonts.gstatic.com; object-src 'none'; " +
    "base-uri 'self'; frame-ancestors 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
if (HTTPS) {
  SECURITY_HEADERS["strict-transport-security"] = "max-age=31536000; includeSubDomains";
}

function httpHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.url === "/health") {
    // Truthful health: the tick loop must be alive (sinceLastTickMs small)
    // and not permanently erroring. A static {ok:true} here would stay
    // green through a wedged simulation.
    const st = matchmaker.healthStats();
    const ok =
      st.sinceLastTickMs >= 0 && st.sinceLastTickMs < 2000 && st.tickErrStreak < 150;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json", ...SECURITY_HEADERS });
    res.end(JSON.stringify({
      ok,
      uptimeS: Math.round((Date.now() - BOOT_AT) / 1000),
      conns: connCount,
      ...st,
    }));
    return;
  }
  if (req.url === "/ping") {
    res.writeHead(200, { "content-type": "application/json", ...SECURITY_HEADERS });
    res.end(JSON.stringify({ ok: true, t: Date.now() }));
    return;
  }

  const url = (req.url ?? "/").split("?")[0] ?? "/";
  const rel = url === "/" ? "index.html" : url.slice(1).replace(/\\/g, "/");
  const abs = path.normalize(path.join(WEB_DIST, rel));

  if (!abs.startsWith(WEB_DIST + path.sep) && abs !== WEB_DIST) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end("forbidden");
    return;
  }

  fs.readFile(abs, (err, data) => {
    if (err) {
      if (url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
        res.end("<!doctype html><meta charset=utf-8><h1>SnakeChain</h1><p>Client build not found.</p>");
        return;
      }
      res.writeHead(404, SECURITY_HEADERS);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
      "cache-control":
        url === "/"
          ? "no-cache"
          : rel.startsWith("assets/")
            // Vite content-hashes these filenames — they never change, so
            // cache them for a year (SW already does the same).
            ? "public, max-age=31536000, immutable"
            : "public, max-age=3600",
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

const server = http.createServer(httpHandler);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  maxPayload: C.MAX_MSG_BYTES,
  perMessageDeflate: false,
  verifyClient: (info, cb) => {
    const origin = info.origin;
    if (origin) {
      let host: string;
      try {
        host = new URL(origin).host.toLowerCase();
      } catch {
        cb(false, 403, "bad origin");
        return;
      }
      if (ALLOWED_ORIGINS.length) {
        if (!ALLOWED_ORIGINS.includes(host)) {
          cb(false, 403, "origin not allowed");
          return;
        }
      } else if (host !== (info.req.headers.host ?? "").toLowerCase()) {
        cb(false, 403, "origin mismatch");
        return;
      }
    }
    cb(true);
  },
});
wss.on("error", (err) => console.error("[ws] server error:", err.message));

function send(c: Conn, obj: unknown): void {
  if (c.ws.readyState !== WebSocket.OPEN) return;
  if (c.ws.bufferedAmount > C.WS_MAX_BUFFERED) {
    c.ws.terminate();
    return;
  }
  c.ws.send(JSON.stringify(obj));
}

function dropConn(c: Conn, reason: string): void {
  if (c.dropped) return;
  c.dropped = true;
  leaveSession(c);
  connsByWs.delete(c.ws);
  if (connCount > 0) connCount--;

  const n = connsByIp.get(c.ip);
  if (n && n <= 1) connsByIp.delete(c.ip);
  else if (n) connsByIp.set(c.ip, n - 1);
}

function leaveSession(c: Conn): void {
  if (c.player && c.session) {
    c.session.removeHuman(c.player.id);
    matchmaker.onHumanLeft(c.session);
    console.log(`[net] ${c.player.name} left ${c.session.id}`);
  }
  c.player = null;
  c.session = null;
}

/** Clamp a client-reported viewport radius once, at the trust boundary.
    Must be a finite number — a truthy non-number here (NaN) poisons every
    later comparison and blanks the client's world. */
function clampViewR(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.round(Math.max(C.VIEW_FLOOR, Math.min(n, C.VIEW_MAX)));
}

function validateJoin(raw: unknown): { name: string; color: number; pattern: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.n !== "string") return null;
  const name = m.n.trim();
  if (name.length < 1 || name.length > C.MAX_NAME_LEN) return null;
  if (!SAFE_NAME.test(name)) return null;
  if (name.includes("<") || name.includes(">") || name.includes("&")) return null;

  let color = 0;
  if (Array.isArray(m.c)) {
    // Canonical chain from explicit palette indices (count nibble first).
    const list = m.c.slice(0, CHAIN_MAX_COLORS).map((v) => Number(v) || 0);
    color = packChain(list);
  } else if (typeof m.c === "number" && Number.isFinite(m.c)) {
    const n = m.c;
    // Canonical wire format: low nibble = chain count (1..8) followed by
    // that many color nibbles. The legal maximum is < 2^37 << 2^53, so a
    // safe-integer bound rejects hostile magnitudes WITHOUT clipping legal
    // 5–8 color chains — the old `%2^20` truncation corrupted exactly
    // those (fifth block silently became palette index 0).
    if (!Number.isSafeInteger(n) || n < 0 || n > CHAIN_PACKED_MAX) return null;
    color = isCanonicalChain(n) ? n : 0; // unknown shape → neutral default
  } else {
    return null;
  }

  const pattern =
    typeof m.p === "number" && Number.isInteger(m.p)
      ? ((m.p % C.NUM_PATTERNS) + C.NUM_PATTERNS) % C.NUM_PATTERNS
      : 0;
  return { name, color, pattern };
}

function handleMessage(c: Conn, text: string): void {
  // Monotonic clock for the flood window (see join branch note).
  const now = performance.now();
  if (now - c.msgWindowStart > 10_000) {
    c.msgWindowStart = now;
    c.msgCount = 0;
  }
  if (++c.msgCount > 800) {
    dropConn(c, "message flood");
    c.ws.terminate();
    return;
  }
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  const m = msg as Record<string, unknown>;

  if (m.t === "join") {
    // Monotonic clock for rate windows: a system-clock jump (NTP) must not
    // hold windows open or expire them all at once.
    const now = performance.now();
    if (now - c.joinWindowStart > 10_000) {
      c.joinWindowStart = now;
      c.joinedCount = 0;
    }
    if (++c.joinedCount > 10) return;
    const v = validateJoin(m);
    if (!v) {
      // A silent ignore strands the client on "ENTERING ARENA…" forever —
      // always tell it why the join did not happen.
      send(c, { t: "joinErr", why: "name" });
      return;
    }
    // Mode routing: “br” joins the collapse arena, everything else classic.
    const mo = m.mo === "br" ? "br" : "classic";
    const session = matchmaker.getArena(mo);
    // ACTOR_CAP covers humans + bots; keep BOT_MAX slots reserved for
    // filler bots and refuse beyond that instead of melting the fixed-step
    // loop with an uncapped arena.
    if (session.humans.size >= C.ACTOR_CAP - C.BOT_MAX) {
      send(c, { t: "joinErr", why: "full" });
      c.ws.close(1013, "arena full");
      return;
    }
    if (c.player && c.session) leaveSession(c);
    const player = new Player(v.name, v.color, v.pattern, false);
    c.player = player;
    c.session = session;
    const vr = clampViewR(m.v);
    c.handle = {
      viewR: vr,
      bodyKnown: new Set<number>(),
      foodKnown: new Set<number>(),
      spectatePid: 0,
      send: (data: string) => {
        if (c.ws.readyState === WebSocket.OPEN && c.ws.bufferedAmount < C.WS_MAX_BUFFERED) {
          c.ws.send(data);
        }
      },
    } satisfies ClientHandle;
    session.addHuman(player, c.handle, true);
    matchmaker.onHumanJoined(session);
    send(c, {
      t: "hi",
      id: player.id,
      w: [session.halfW, session.halfH],
      tick: 1000 / C.TICK_RATE,
      v: clientBuild(),
      // Prediction constants so client steering math can never drift from
      // server authority when these are tuned.
      turn: [C.MAX_TURN_SPEED, C.MIN_TURN_SPEED, C.TURN_SPEED_FALLOFF],
    });
    // Route through the guarded handle send (bufferedAmount back-pressure)
    // instead of a raw ws.send — the snapshot can exceed 100KB on desktop
    // view radii.
    c.handle.send(session.foodSnapshot(player, vr + C.INTEREST_SAFETY, c.handle.foodKnown));
    console.log(`[net] ${player.name} joined ${session.id} (${session.humans.size} humans, ${session.botCount()} bots)`);
    return;
  }

  if (m.t === "view") {
    if (!c.handle) return;
    const rv = m.r;
    if (typeof rv !== "number" || !Number.isFinite(rv) || rv <= 0) return;
    c.handle.viewR = clampViewR(rv);
    // Optional spectate target: while this client is dead, interest filtering
    // centers on that LIVE player instead of the corpse. Validated strictly.
    if (m.tg !== undefined) {
      const tg = m.tg;
      c.handle.spectatePid =
        typeof tg === "number" && Number.isInteger(tg) && tg > 0 && tg < 2 ** 31
          ? tg
          : 0;
    }
    return;
  }

  if (m.t === "input") {
    if (!c.player || !c.player.alive || !c.session) return;
    const now = performance.now();
    if (now - c.lastInputAt > 1000) {
      c.lastInputAt = now;
      c.inputCount = 0;
    }
    if (++c.inputCount > C.INPUT_RATE_PER_SEC) return;
    const a = m.a;
    const b = m.b;
    if (typeof a !== "number" || !Number.isFinite(a)) return;
    if (typeof b !== "boolean") return;
    // Store the desired heading, not the heading itself: move() clamps the
    // turn toward it at maxTurnRate. Accepting the raw angle would let a
    // modified client instant-flip 180° (self-collision is off, so that is
    // a free escape from any head-on).
    c.player.targetAngle = normAngle(a);
    c.player.boosting = b;
    return;
  }

  if (m.t === "ping") {
    const n = m.n;
    if (typeof n === "number" && Number.isFinite(n)) send(c, { t: "pong", n });
    return;
  }

  if (m.t === "quit") {
    leaveSession(c);
  }
}

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  // Reject before any counter is incremented: a rejected socket never gets a
  // Conn, so nothing will ever decrement on its behalf — incrementing first
  // would leak the per-IP counter and lock that IP out permanently.
  if (connCount >= MAX_CONNS) {
    ws.close(1013, "server full");
    return;
  }
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost") {
    const current = connsByIp.get(ip) ?? 0;
    if (current >= MAX_PER_IP) {
      ws.close(1013, "too many connections");
      return;
    }
    connsByIp.set(ip, current + 1);
  }
  connCount++;

  const c: Conn = {
    ws,
    ip,
    player: null,
    session: null,
    handle: null,
    aliveSincePing: true,
    lastInputAt: 0,
    inputCount: 0,
    joinedCount: 0,
    joinWindowStart: 0,
    dropped: false,
    msgCount: 0,
    msgWindowStart: 0,
  };
  connsByWs.set(ws, c);

  ws.on("message", (data) => {
    try {
      handleMessage(c, data.toString());
    } catch (err) {
      // One malformed/hostile frame must never take the process down.
      console.error("[net] message handler error", err);
    }
  });

  ws.on("pong", () => {
    c.aliveSincePing = true;
  });

  ws.on("close", () => {
    // dropConn owns all connection accounting (connCount, connsByIp,
    // connsByWs). Decrementing here too would double-count every
    // disconnect and permanently disable the MAX_CONNS cap.
    dropConn(c, "client disconnected");
  });

  ws.on("error", () => {
    // Accounting happens in "close" (which always follows a socket error).
    // Without this, error+close would double-decrement connCount and the
    // MAX_CONNS cap would silently stop being enforced.
    connsByWs.delete(ws);
    dropConn(c, "socket error");
    ws.terminate();
  });
});

setInterval(() => {
  for (const [ws, c] of connsByWs) {
    if (!c.aliveSincePing) {
      ws.terminate();
      continue;
    }
    c.aliveSincePing = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, C.HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`[server] SNAKECHAIN listening on http://0.0.0.0:${PORT} (ws /ws)`);
  console.log(
    `[server] caps: MAX_CONNS=${MAX_CONNS} MAX_PER_IP=${MAX_PER_IP} ALLOWED_ORIGINS=${JSON.stringify(ALLOWED_ORIGINS)}`
  );
  console.log(
    `[server] boost: BOOST_SPEED=${C.BOOST_SPEED} DRAIN=${C.BOOST_DRAIN_PER_SEC}/s MIN=${C.BOOST_MIN_LENGTH}`
  );
});

function shutdown(): void {
  for (const c of wss.clients) c.close(1001, "server shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
// Last-resort process guards: the tick loop and message handler isolate
// their own failures, but a stray throw outside those paths must LOG instead
// of silently killing the process (Render restarts are a cold start players
// wait through).
process.on("uncaughtException", (err) => console.error("[fatal] uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("[fatal] unhandledRejection:", err));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
