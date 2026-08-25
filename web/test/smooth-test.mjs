import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const URL = process.env.TEST_URL ?? "http://localhost:8787/?dbg";
const FAIL = [];
let pass = 0;
const check = (name, cond, extra = "") => {
  if (cond) pass++;
  else FAIL.push(`${name} ${extra}`);
};

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const page = await browser.newPage();
page.setDefaultTimeout(30000);
await page.setViewport({ width: 1280, height: 800 });
await page.goto(URL, { waitUntil: "load", timeout: 20000 });
await page.waitForSelector("#menu:not(.hidden)", { visible: true });
await page.type("#name", "SmoothTester");
await page.click("#play");
await page.waitForSelector("#hud:not(.hidden)", { visible: true, timeout: 20000 }).catch(async () => {
  const s = await page.evaluate(() => {
    const hud = document.getElementById("hud");
    const dead = document.getElementById("death");
    const conn = document.getElementById("connLost");
    return {
      hud: hud && !hud.classList.contains("hidden"),
      dead: dead && !dead.classList.contains("hidden"),
      conn: conn && !conn.classList.contains("hidden"),
    };
  });
  if (s.dead) await page.click("#respawn");
  else if (s.conn) await page.click("#reconnect");
  if (s.dead || s.conn) await page.waitForSelector("#hud:not(.hidden)", { visible: true, timeout: 20000 });
  else throw new Error("join failed: " + JSON.stringify(s));
});
await page.waitForFunction(() => {
  const st = window.__state;
  return st && st.players.has(st.myId) && st.players.size >= 2;
}, { timeout: 20000 });

// Sample rendered head position at 25ms via setInterval (headless rAF is
// throttled to ~10fps, which would pollute per-frame smoothness numbers).
const collect = (pid, durMs = 4000) =>
  page.evaluate(
    async (targetId, dur) => {
      const st = window.__state;
      const samples = [];
      const t0 = performance.now();
        await new Promise((resolve) => {
          const iv = setInterval(() => {
            const pl = st.players.get(targetId);
            if (pl) samples.push({ t: performance.now(), x: pl.x, y: pl.y, tx: pl.tx, ty: pl.ty, rt: pl.lastRowT, vx: pl.vx, len: pl.len });
            if (performance.now() - t0 > dur) {
              clearInterval(iv);
              resolve();
            }
          }, 25);
        });
      return samples;
    },
    pid,
    durMs,
  );

const analyze = (samples, label) => {
  const speeds = [];
  const rowGaps = [];
  let prevRt = -1;
  let segStart = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    const jump = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    if (jump > 80) segStart = i; // death/respawn teleport — drop segment
    if (dt > 0.01 && dt < 0.25 && i > segStart) {
      speeds.push(jump / dt);
    }
    if (samples[i].rt !== prevRt && samples[i].rt !== samples[i - 1].rt) {
      rowGaps.push(samples[i].rt - samples[i - 1].rt);
      prevRt = samples[i].rt;
    }
  }
  const mean = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  const std = Math.sqrt(speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / speeds.length);
  const slowFrames = speeds.filter((v) => v < mean * 0.4).length;
  const bursts = rowGaps.filter((g) => g < 5).length;
  const errs = samples.filter((s) => s.rt && s.t - s.rt < 400).map((s) => Math.hypot(s.x - s.tx, s.y - s.ty));
  const meanErr = errs.reduce((s, v) => s + v, 0) / errs.length;
  console.log(`${label}: avg=${mean.toFixed(1)}px/s cv=${(std / mean).toFixed(3)} slow=${slowFrames}/${speeds.length} bursts=${bursts}/${rowGaps.length} followErr=${meanErr.toFixed(1)}px`);
  return { mean, cv: std / mean, slowFrames, total: speeds.length, bursts, meanErr };
};

// Boost only counts while the snake is above the boost floor (45 len —
// BOOST_MIN_LENGTH in server/src/config.ts; keep in sync). Below it the
// server drops to base speed, polluting boost metrics. Gate analysis on
// len > floor + 5.
const BOOST_FLOOR = 45;
const boostStats = (samples) => {
  const speeds = [];
  let segStart = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i].t - samples[i - 1].t) / 1000;
    const jump = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y);
    if (jump > 80) segStart = i;
    if (dt > 0.01 && dt < 0.25 && i > segStart && samples[i].len > BOOST_FLOOR + 5 && samples[i - 1].len > BOOST_FLOOR + 5) {
      speeds.push(jump / dt);
    }
  }
  const mean = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  const std = Math.sqrt(speeds.reduce((s, v) => s + (v - mean) ** 2, 0) / speeds.length);
  const slowFrames = speeds.filter((v) => v < mean * 0.4).length;
  console.log(`me-boost: avg=${mean.toFixed(1)}px/s cv=${(std / mean).toFixed(3)} slow=${slowFrames}/${speeds.length}`);
  return { mean, cv: std / mean, slowFrames, total: speeds.length };
};

await page.mouse.move(640, 400);
await page.mouse.down(); // hold boost — server ignores it below BOOST_FLOOR (45)

// Boost is locked while the snake is small: measure ~2s of motion and
// assert it stays at base speed, not boost speed.
let meId = await page.evaluate(() => window.__state.myId);
const deadShown = () =>
  page.evaluate(() => (document.getElementById("death")?.classList.contains("hidden") ?? true) === false);
const respawnIfDead = async () => {
  if (await deadShown()) {
    await page.evaluate(() => document.getElementById("respawn").click());
    await new Promise((r) => setTimeout(r, 600));
    meId = await page.evaluate(() => window.__state.myId);
  }
};
let growth;
for (let attempt = 0; attempt < 3; attempt++) {
  growth = analyze(await collect(meId, 2000), "me-growth");
  if (Number.isFinite(growth.mean) && growth.total > 10) break;
  await respawnIfDead(); // died mid-collect — respawn and retry
}
  check("boost-locked-below-floor", growth.mean > 100 && growth.mean < 250, `avg=${growth.mean.toFixed(1)}`);

// Release boost for the growth phase: held boost drains 6 len/s
// (BOOST_DRAIN_PER_SEC) and there is NO passive growth (PASSIVE_GROW_PER_SEC
// = 0) — the snake only grows by eating, so held boost would pin it at the
// boost floor forever.
await page.mouse.up();

// While the snake passively grows (2/s + food), measure the bots — they
// don't need us alive (world simulation runs even after our death).
const botIds = await page.evaluate(() => {
  const ids = [];
  for (const [id, p] of window.__state.players) if (p.isBot) ids.push(id);
  return ids;
});
const bots = [];
for (const bid of botIds) {
  const s = await collect(bid);
  const a = analyze(s, `bot#${bid}`);
  bots.push({ bid, a });
}
bots.sort((x, y) => y.a.meanErr - x.a.meanErr);
if (bots.length) {
  const bot = bots[0].a;
  check("bot-follows-truth", bot.meanErr < 60, `err=${bot.meanErr.toFixed(1)}px mean=${bot.mean.toFixed(1)}`);
} else {
  console.log("bot: none in arena");
}

// Grow to comfortably above the boost floor so the boost phase lasts.
// Held boost drains 6 len/s (BOOST_DRAIN_PER_SEC) and there is NO passive
// growth (PASSIVE_GROW_PER_SEC = 0) — the snake only grows by eating, so
// held boost would pin it at the boost floor forever.
const deadline = Date.now() + 240000;
let grew = false;
let ticks = 0;
let aliveTicks = 0;
while (Date.now() < deadline) {
  const target = await page.evaluate(() => {
    const s = window.__state;
    const p = s && s.players.get(s.myId);
    if (!p) return { len: 0, mx: 0, my: 0, alive: false };
    const zoom = Math.max(0.62, Math.min(1.55, 1.55 - p.len / 3200));
    let best = null;
    let bd = Infinity;
    for (const f of s.food.values()) {
      const d = Math.hypot(f[0] - p.x, f[1] - p.y);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    if (!best || bd > 1500) return { len: p.len, mx: 0, my: 0, alive: true, bd: Math.round(bd), food: s.food.size };
    return {
      len: p.len,
      mx: (best[0] - p.x) * zoom + window.innerWidth / 2,
      my: (best[1] - p.y) * zoom + window.innerHeight / 2,
      alive: true,
      bd: Math.round(bd),
      food: s.food.size,
    };
  });
  ticks++;
  if (target.alive) aliveTicks++;
  if (target.len > 180) {
    grew = true;
    break;
  }
  if (target.mx !== 0 || target.my !== 0) await page.mouse.move(target.mx, target.my);
  await respawnIfDead();
  await new Promise((r) => setTimeout(r, 250));
}
console.log(`growth-summary: ticks=${ticks} aliveFraction=${(aliveTicks / ticks).toFixed(2)}`);
if (!grew) throw new Error("snake never grew past 180 len");

await page.mouse.down(); // hold boost for the boost-phase measurements

const meSamples = await collect(meId);
const me = analyze(meSamples, "me");
const meb = boostStats(meSamples);
check("me-speed~300", meb.mean > 250 && meb.mean < 380, `avg=${meb.mean.toFixed(1)}`);
check("me-smooth-cv", meb.cv < 0.35, `cv=${meb.cv.toFixed(3)}`);
check("me-no-stutter", me.slowFrames <= me.total * 0.03, `slow=${me.slowFrames}/${me.total}`);
check("me-no-burst-rows", me.bursts === 0, `bursts=${me.bursts}/${me.rowSamples}`);
check("me-follows-truth", me.meanErr < 60, `err=${me.meanErr.toFixed(1)}px`);

await page.mouse.up();
await browser.close();
console.log(`PASS ${pass}  FAIL ${FAIL.length}`);
if (FAIL.length) {
  for (const f of FAIL) console.log("  - " + f);
  process.exit(1);
}
