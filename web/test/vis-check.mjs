import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TEST_URL ?? "http://127.0.0.1:8787/";

const COLORS = [
  "#FF4D4D", "#FF8A3D", "#FFD93D", "#6BCB77",
  "#3DA5FF", "#7C5CFF", "#FF5CA8", "#00D1C0",
  "#FF9A9E", "#A8FF3D", "#C0C0FF", "#FFB84D",
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
await page.type("#name", "visCheck");
await page.click("#play");

for (let i = 0; i < 6; i++) {
  await page.waitForSelector("#hud:not(.hidden)", { visible: true, timeout: 10000 }).catch(() => {});
  const st = await page.evaluate(() => ({
    hud: !document.getElementById("hud").classList.contains("hidden"),
    dead: !document.getElementById("death").classList.contains("hidden"),
  }));
  if (st.hud) break;
  if (st.dead) await page.click("#respawn").catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}

await new Promise((r) => setTimeout(r, 20000));

const stats = await page.evaluate((cols) => {
  const canvas = document.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h).data;
  // center region (my snake lives near camera center) vs edge region
  const cx = w / 2, cy = h / 2;
  const centerR2 = 220 * 220;
  let edgeSnake = 0, centerSnake = 0, food = 0;
  const byColor = new Array(cols.length).fill(0);
  for (let i = 0; i < img.length; i += 8) {
    const x = (i / 4) % w, y = Math.floor(i / 4 / w);
    const r = img[i], g = img[i + 1], b = img[i + 2];
    const d2 = (x - cx) ** 2 + (y - cy) ** 2;
    let matched = -1;
    for (let c = 0; c < cols.length; c++) {
      if (Math.abs(r - cols[c][0]) < 40 && Math.abs(g - cols[c][1]) < 40 && Math.abs(b - cols[c][2]) < 40) {
        matched = c;
        break;
      }
    }
    if (matched >= 0) {
      byColor[matched]++;
      if (d2 < centerR2) centerSnake++;
      else edgeSnake++;
    } else {
      const d = Math.abs(r - 0x10) + Math.abs(g - 0x1c) + Math.abs(b - 0x3a);
      if (d > 60) food++;
    }
  }
  return { w, h, edgeSnake, centerSnake, food, byColor };
}, COLORS);

console.log(JSON.stringify(stats, null, 2));
await browser.close();
process.exit(0);
