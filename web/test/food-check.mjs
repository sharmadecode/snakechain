import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TEST_URL ?? "http://127.0.0.1:8787/";

// Must mirror web/src/patterns.ts PALETTE exactly — the pixel classifier
// can only find what the renderer actually draws.
const FOOD_COLORS = [
  "#FFD93D", "#FF5722", "#00C2D1", "#A8E10C",
  "#FF5CA8", "#7C5CFF", "#00D1C0", "#FF3B30",
  "#FF9A9E", "#C0C0FF", "#FFAA00", "#FFFFFF",
].map((h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
});

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

const page = await browser.newPage();
page.setDefaultTimeout(20000);
await page.setViewport({ width: 1440, height: 900 });
await page.goto(URL, { waitUntil: "load" });

await page.waitForSelector("#menu:not(.hidden)", { visible: true, timeout: 10000 });
await page.type("#name", "foodCheck");
await page.click("#play");

let alive = false;
for (let i = 0; i < 6; i++) {
  await page.waitForSelector("#hud:not(.hidden)", { visible: true, timeout: 10000 }).catch(() => {});
  const st = await page.evaluate(() => ({
    hud: !document.getElementById("hud").classList.contains("hidden"),
    dead: !document.getElementById("death").classList.contains("hidden"),
    conn: !document.getElementById("connLost").classList.contains("hidden"),
  }));
  if (st.hud && !st.conn) { alive = true; break; }
  if (st.dead) await page.click("#respawn").catch(() => {});
  if (st.conn) await page.click("#reconnect").catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}

await new Promise((r) => setTimeout(r, 4000));

const stats = await page.evaluate((cols) => {
  const canvas = document.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h).data;
  let foodPx = 0, other = 0;
  for (let i = 0; i < img.length; i += 8) {
    const r = img[i], g = img[i + 1], b = img[i + 2];
    let isFood = false;
    for (const c of cols) {
      if (Math.abs(r - c[0]) < 40 && Math.abs(g - c[1]) < 40 && Math.abs(b - c[2]) < 40) { isFood = true; break; }
    }
    if (isFood) foodPx++;
    else {
      const d = Math.abs(r - 0x10) + Math.abs(g - 0x1c) + Math.abs(b - 0x3a);
      if (d > 60) other++;
    }
  }
  return { w, h, foodPx, other };
}, FOOD_COLORS);

console.log(JSON.stringify({ alive, ...stats }, null, 2));
await browser.close();
// Gate the run: joining must succeed and palette-colored pixels must exist
// on screen (previously this script always exited 0 — decorative, not a test).
process.exit(alive && stats.foodPx > 0 ? 0 : 1);
