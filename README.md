# SnakeChain.io — Multiplayer Block Combat Arena

Multiplayer browser snake game. **`web/`** is the TypeScript + Canvas2D client
(Vite), **`server/`** is the authoritative Node WebSocket server running a 30 TPS
fixed-step simulation. Designed to run as ONE free-tier service: the server serves
the built client and the WebSocket at `/ws`.

## Repo layout

| Path | What it is |
|---|---|
| `server/src/` | Game server: `server.ts` (transport/auth/rate limits/static), `session.ts` (simulation + broadcast), `player.ts` (movement/collision/economy), `bot.ts` (AI), `food.ts`, `grid.ts` (spatial hash), `colors.ts` (skin codec), `config.ts` (**all gameplay tunables live here**) |
| `web/src/` | Client: `main.ts` (loop/wiring), `state.ts` (net-state + smoothing), `render.ts` (Canvas2D), `input.ts`, `ui.ts`, `net.ts`, `audio.ts`, `patterns.ts` |
| `web/test/` | Puppeteer harnesses (`ui-test.mjs`, `smooth-test.mjs`, `gameplay-check.mjs`, `food-check.mjs`, `vis-check.mjs`) — need the server running on `:8787` and Edge installed |
| `server/test/` | `stress.ts` (headless load harness), `colors.test.ts` (pure unit tests) |

## Local development

```bash
# terminal 1 — server (port 8787)
cd server && npm install && npm run dev        # tsx watch src/server.ts

# terminal 2 — client dev server (port 5174, proxies /ws → :8787)
cd web && npm install && npm run dev
```

Production-style local run: build the client, then let the server serve it.

```bash
cd web && npm run build          # outputs web/dist/
cd server && npm run build       # tsc → dist/
npm start                        # node --max-old-space-size=400 dist/src/server.js
```

Health checks: `GET /health` (truthful tick-liveness, player counts) and `GET /ping`.

## Environment variables (all optional)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP+WS listen port |
| `TRUST_PROXY` | unset | **Set to `1` on Render/any reverse proxy.** Without it every client shares the proxy IP and `MAX_PER_IP` locks everyone out |
| `MAX_PER_IP` | `8` | Concurrent WebSocket connections per client IP |
| `MAX_CONNS` | `1000` | Global connection cap |
| `ALLOWED_ORIGINS` | *(host-match)* | Comma-separated origin allowlist; empty = Origin must match Host |
| `HTTPS` | unset | `1` adds HSTS (use behind a TLS terminator) |
| `WEB_DIST` | auto-discovered | Override path to the built client (`web/dist`) |
| `STRESS` | unset | `1` = 10s perf-log cadence for load testing |

Gameplay tunables (bot caps, speeds, food economy, interest radius…) are all in
`server/src/config.ts` with rationale comments — no env vars needed for those.
The two constants that MUST stay in sync across client and server are documented
in both files (`DEATH_DROP_GLOW_MS`, turn-rate model — the latter also travels in
the join handshake so an old client can't desync).

## Deploying (Render free tier)

`render.yaml` at the repo root is a working template (single Node service that
builds the client then runs the compiled server). Key points:

- **Set `TRUST_PROXY=1`.** The server logs a loud warning at boot if it detects
  proxy hosting without it.
- One service serves both static assets and WebSockets — no separate static host needed.
- Free tier spins down when idle and has ~30–60s cold starts; the client
  auto-retries failed connects (3 attempts, backoff) before showing RECONNECT.
- Egress is the first resource to run out (~100GB/mo). Per-user downstream scales
  with arena population; the body model, streaming budget and renderer pipeline are
  documented in PHASES.md.

### Runbook

- **Restart / redeploy:** push to the connected branch (Render auto-deploys), or
  Manual Deploy → Clear build cache & deploy. Players see a stale-build banner and
  reload; in-flight matches end gracefully (close code 1001).
- **Incident triage:** check `/health` first — `ok:false` means a wedged tick loop
  or an elevated error streak (`tickErrStreak ≥ ~150`). `[perf]` logs print every
  60s with ms/tick, players, food count. `[fatal] uncaughtException/unhandledRejection`
  lines indicate bugs that previously would have killed the process.
- **Arena full:** server refuses joins past `ACTOR_CAP - BOT_MAX` humans with close
  code 1013; clients show "ARENA FULL — TRY AGAIN SOON".

## Tests

```bash
cd server && npm run test:unit    # pure unit tests (no sockets)
cd server && STRESS=1 npm run stress -- N=50 SECONDS=30   # needs server on :8787
cd web && npm test                # full UI/gesture matrix (needs server + Edge)
```

The puppeteer harnesses locate Edge via a hardcoded path — override per environment
if needed (see the `EDGE` constant at the top of each script).
