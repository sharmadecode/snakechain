/**
 * Headless stress test: N human clients hammer the server with inputs while
 * bots are simulated server-side. Verifies invariants and prints results.
 *
 * Usage: STRESS=1 npm run stress -- N=50 SECONDS=30
 */
import { WebSocket } from "ws";

const N = Number(process.env.N ?? 50);
const SECONDS = Number(process.env.SECONDS ?? 40);
const URL = process.env.URL ?? "ws://localhost:8787/ws";

let states = 0;
let badValues = 0;
let outOfBounds = 0;
let foodEvents = 0;
let deaths = 0;
let deadMsgs = 0;
let hiCount = 0;
let lbCount = 0;
let maxGap = 0;
let clientsDone = 0;
const perClient: Array<{ joined: boolean; ticks: number; lastTick: number }> = [];

function makeClient(i: number, autoQuitAfter: number): void {
  const st = perClient[i] ??= { joined: false, ticks: 0, lastTick: 0 };
  const ws = new WebSocket(URL);
  let quitSent = false;

  const inputTimer = setInterval(() => {
    if (st.joined && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        t: "input",
        a: Math.random() * Math.PI * 2,
        b: Math.random() < 0.05,
      }));
    }
  }, 33);

  const quitTimer = setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN && !quitSent) {
      quitSent = true;
      ws.send(JSON.stringify({ t: "quit" }));
      setTimeout(() => ws.terminate(), 300);
    }
  }, autoQuitAfter * 1000);

  ws.on("open", () => {
    ws.send(JSON.stringify({ t: "join", n: `T${String(i).padStart(2, "0")}`, c: i % 12, p: i % 5 }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (msg.t === "hi") {
      hiCount++;
      st.joined = true;
      st.lastTick = Date.now();
      return;
    }
    if (msg.t === "s") {
      const now = Date.now();
      if (st.lastTick) {
        const gap = now - st.lastTick;
        if (gap > maxGap) maxGap = gap;
        if (gap > 500) badValues++;
      }
      st.lastTick = now;
      st.ticks++;
      states++;
      const w = (msg.w as number[])[0]! + 1;
      const h = (msg.w as number[])[1]! + 1;
      for (const p of msg.p as unknown[][]) {
        const x = p[1] as number;
        const y = p[2] as number;
        const a = p[3] as number;
        const len = p[4] as number;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(a) || !Number.isFinite(len)) {
          badValues++;
        }
        if (Math.abs(x) > w || Math.abs(y) > h) outOfBounds++;
      }
      return;
    }
    if (msg.t === "f") foodEvents++;
    if (msg.t === "kf") deaths++;
    if (msg.t === "dead") deadMsgs++;
    if (msg.t === "lb") lbCount++;
  });

  const done = () => {
    clearInterval(inputTimer);
    clearTimeout(quitTimer);
    ws.terminate();
    if (++clientsDone === N) print();
  };
  ws.on("close", done);
  ws.on("error", (e) => {
    console.error(`client ${i} error`, e.message);
    done();
  });
}

function print(): void {
  const ok = badValues === 0 && outOfBounds === 0 && hiCount >= N - 1 && maxGap < 400;
  console.log("========== STRESS RESULT ==========");
  console.log(`clients        : ${N}`);
  console.log(`joined (hi)    : ${hiCount}/${N}`);
  console.log(`states recv    : ${states} (${Math.round((states / SECONDS) * 10) / 10}/s/client)`);
  console.log(`leaderboards   : ${lbCount}`);
  console.log(`food events    : ${foodEvents}`);
  console.log(`kill feeds     : ${deaths}`);
  console.log(`death msgs     : ${deadMsgs}`);
  console.log(`max tick gap   : ${maxGap}ms`);
  console.log(`bad values     : ${badValues}`);
  console.log(`out of bounds  : ${outOfBounds}`);
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
}

for (let i = 0; i < N; i++) {
  makeClient(i, SECONDS * 0.75);
}

setTimeout(() => {
  console.log("TEST TIMEOUT");
  process.exit(2);
}, (SECONDS + 10) * 1000);
