import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TEST_URL ?? "http://127.0.0.1:8787/";

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push("console: " + m.text());
});

await page.goto(URL, { waitUntil: "load" });
await page.waitForSelector("#menu:not(.hidden)", { visible: true });
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: "test/shot-menu.png" });

// Empty-name guard
await page.evaluate(() => {
  localStorage.clear();
  const n = document.getElementById("name");
  n.value = "";
});
await page.click("#play");
await new Promise((r) => setTimeout(r, 300));
const guard = await page.evaluate(() => ({
  err: !document.getElementById("nameError").classList.contains("hidden"),
  menu: !document.getElementById("menu").classList.contains("hidden"),
}));
console.log(`empty-name guard: ${guard.err && guard.menu ? "PASS (blocked with inline error)" : "FAIL " + JSON.stringify(guard)}`);

// Join and play
await page.evaluate(() => document.getElementById("name").focus());
await page.keyboard.type("VerifyBot");
await page.click("#play");
try {
  await page.waitForSelector("#hud:not(.hidden)", { visible: true, timeout: 10000 });
} catch {
  console.log("join: FAIL (HUD never appeared)");
  await page.screenshot({ path: "test/shot-join-fail.png" });
  await browser.close();
  process.exit(1);
}

// Steer in circles for 12s; watch for crashes, invisible-snake proximity, and renderer state
const started = Date.now();
let maxPlayers = 0;
let selfVisible = false;
let deaths = 0;
while (Date.now() - started < 12000) {
  const a = (Date.now() / 700) % (Math.PI * 2);
  await page.mouse.move(640 + Math.cos(a) * 260, 400 + Math.sin(a) * 200);
  const st = await page.evaluate(() => {
    const s = window.__state;
    if (!s) return null;
    const me = s.getSelf();
    // Count snakes whose drawn body is anywhere near us (within 600 units) —
    // with the culling fix, anything lethal nearby must be renderable.
    let near = 0;
    for (const pl of s.players.values()) {
      if (pl === me) continue;
      const d = Math.hypot(pl.x - me.x, pl.y - me.y);
      if (d < 600) near++;
    }
    return {
      players: s.players.size,
      alive: s.alive,
      myLen: me ? Math.round(me.len) : 0,
      near,
      ping: s.ping,
    };
  }).catch(() => null);
  if (st) {
    maxPlayers = Math.max(maxPlayers, st.players);
    selfVisible = selfVisible || st.myLen > 0;
    if (!st.alive) deaths++;
  }
  await new Promise((r) => setTimeout(r, 400));
}

await page.screenshot({ path: "test/shot-game.png" });
const overlays = await page.evaluate(() => ({
  hud: !document.getElementById("hud").classList.contains("hidden"),
  death: !document.getElementById("death").classList.contains("hidden"),
  connLost: !document.getElementById("connLost").classList.contains("hidden"),
  pingShown: document.getElementById("pingBadge").textContent,
}));

console.log(`gameplay: players seen max=${maxPlayers}, self tracked=${selfVisible}, deaths during window=${deaths}`);
console.log(`overlays: ${JSON.stringify(overlays)}`);
console.log(`js errors: ${errors.length === 0 ? "none" : errors.slice(0, 5).join(" | ")}`);

const ok = maxPlayers > 1 && selfVisible && errors.length === 0 && overlays.hud;
console.log(ok ? "GAMEPLAY CHECK: PASS" : "GAMEPLAY CHECK: FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
