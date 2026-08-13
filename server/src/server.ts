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

const CLIENT_BUILD = ((): string => {
  try {
    const html = fs.readFileSync(path.join(WEB_DIST, "index.html"), "utf8");
    return /assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0] ?? "";
  } catch {
    return "";
  }
})();

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
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' ws: wss:; img-src 'self'; font-src 'self'; object-src 'none'; " +
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
    res.writeHead(200, { "content-type": "application/json", ...SECURITY_HEADERS });
    res.end(JSON.stringify({ ok: true }));
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
    if (err || !fs.existsSync(abs)) {
      if (url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
        res.end("<!doctype html><meta charset=utf-8><h1>BLOCKS</h1><p>Client build not found.</p>");
        return;
      }
      res.writeHead(404, SECURITY_HEADERS);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(abs).toLowerCase()] ?? "application/octet-stream",
      "cache-control": url === "/" ? "no-cache" : "public, max-age=3600",
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

const server = http.createServer(httpHandler);
server.maxRequestsPerSocket = 500;
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

function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff) return xff.split(",")[0]!.trim();
  }
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

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
  console.log(`[net] closed: ${reason}`);
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
    let packed = 0;
    const len = Math.max(1, m.c.length);
    for (let i = 0; i < 5; i++) {
      const val = Number(m.c[i % len]) || 0;
      const ci = ((Math.floor(val) % C.NUM_COLORS) + C.NUM_COLORS) % C.NUM_COLORS;
      packed += ci * (16 ** i);
    }
    color = packed;
  } else if (typeof m.c === "number" && Number.isFinite(m.c) && m.c >= 0 && m.c <= Number.MAX_SAFE_INTEGER) {
    color = Math.floor(m.c);
  } else {
    return null;
  }

  const pattern = typeof m.p === "number" && Number.isInteger(m.p) ? m.p : 0;
  return { name, color, pattern };
}

function handleMessage(c: Conn, text: string): void {
  const now = Date.now();
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
    const now = Date.now();
    if (now - c.joinWindowStart > 10_000) {
      c.joinWindowStart = now;
      c.joinedCount = 0;
    }
    if (++c.joinedCount > 10) return;
    const v = validateJoin(m);
    if (!v) return;
    if (c.player && c.session) leaveSession(c);
    const session = matchmaker.getArena();
    const player = new Player(v.name, v.color, v.pattern, false);
    c.player = player;
    c.session = session;
    // Client-reported viewport radius, clamped to a safe range. A modified
    // client must never be able to request the whole world.
    const vr = Math.round(Math.max(C.VIEW_HALF, Math.min(m.v as number || 0, C.VIEW_MAX)));
    c.handle = {
      viewR: vr,
      bodyKnown: new Set<number>(),
      send: (data: string) => {
        if (c.ws.readyState === WebSocket.OPEN && c.ws.bufferedAmount < C.WS_MAX_BUFFERED) {
          c.ws.send(data);
        }
      },
    } satisfies ClientHandle;
    session.addHuman(player, c.handle, true);
    matchmaker.onHumanJoined(session);
    send(c, { t: "hi", id: player.id, w: [session.halfW, session.halfH], tick: 1000 / C.TICK_RATE, v: CLIENT_BUILD });
    c.ws.send(session.foodSnapshot(player, vr));
    console.log(`[net] ${player.name} joined ${session.id} (${session.humans.size} humans, ${session.botCount()} bots)`);
    return;
  }

  if (m.t === "view") {
    if (!c.handle) return;
    const rv = m.r;
    if (typeof rv !== "number" || !Number.isFinite(rv) || rv <= 0) return;
    c.handle.viewR = Math.round(Math.max(C.VIEW_HALF, Math.min(rv, C.VIEW_MAX)));
    return;
  }

  if (m.t === "input") {
    if (!c.player || !c.player.alive || !c.session) return;
    const now = Date.now();
    if (now - c.lastInputAt > 1000) {
      c.lastInputAt = now;
      c.inputCount = 0;
    }
    if (++c.inputCount > C.INPUT_RATE_PER_SEC) return;
    const a = m.a;
    const b = m.b;
    if (typeof a !== "number" || !Number.isFinite(a)) return;
    if (typeof b !== "boolean") return;
    c.player.angle = normAngle(a);
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
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "localhost") {
    const current = connsByIp.get(ip) ?? 0;
    if (current >= MAX_PER_IP) {
      ws.close(1013, "too many connections");
      return;
    }
    connsByIp.set(ip, current + 1);
  }
  if (connCount >= MAX_CONNS) {
    ws.close(1013, "server full");
    return;
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
    handleMessage(c, data.toString());
  });

  ws.on("pong", () => {
    c.aliveSincePing = true;
  });

  ws.on("close", () => {
    connsByWs.delete(ws);
    connCount--;
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
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
