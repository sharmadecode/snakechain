import puppeteer from "puppeteer-core";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TEST_URL ?? "http://127.0.0.1:8787/";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "desktop-1024x768", width: 1024, height: 768 },
  { name: "tablet-768x1024", width: 768, height: 1024, mobile: true },
  { name: "phone-390x844", width: 390, height: 844, mobile: true },
  { name: "phone-360x640", width: 360, height: 640, mobile: true },
  { name: "phone-320x568", width: 320, height: 568, mobile: true },
  { name: "landscape-844x390", width: 844, height: 390, mobile: true },
  { name: "landscape-667x375", width: 667, height: 375, mobile: true },
];

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--no-sandbox", "--disable-gpu"],
});

async function steerCircle(client, cx, cy, radius, t, n) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius }],
    });
    await new Promise((res) => setTimeout(res, t / n));
  }
}

async function steerMouse(page, t, n) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const vp = page.viewport();
    await page.mouse.move(vp.width / 2 + Math.cos(a) * 200, vp.height / 2 + Math.sin(a) * 200);
    await new Promise((res) => setTimeout(res, t / n));
  }
}

async function joinAndStabilize(page, mobile) {
  let hud;
  for (let attempt = 0; attempt < 4; attempt++) {
    hud = await page.evaluate(() => {
      const hudEl = document.getElementById("hud");
      const deadEl = document.getElementById("death");
      const connEl = document.getElementById("connLost");
      return {
        hudShown: !hudEl.classList.contains("hidden"),
        deadShown: !deadEl.classList.contains("hidden"),
        connShown: !connEl.classList.contains("hidden"),
      };
    });
    if (hud.hudShown && !hud.connShown) return hud;
    if (hud.deadShown) await page.click("#respawn");
    else if (hud.connShown) await page.click("#reconnect");
    await page.waitForSelector("#hud:not(.hidden)", { visible: true, timeout: 10000 });
  }
  return hud;
}

const results = [];
for (let vi = 0; vi < viewports.length; vi++) {
  const vp = viewports[vi];
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  if (vi === 0) page.setDefaultTimeout(60000); // cold browser start is slow
  await page.emulate({
    viewport: { width: vp.width, height: vp.height, isMobile: !!vp.mobile, hasTouch: !!vp.mobile },
    userAgent: vp.mobile
      ? "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36",
  });
  const r = { name: vp.name, vw: vp.width, vh: vp.height, checks: [] };
  const fail = (msg) => r.checks.push({ ok: false, msg });
  const ok = (msg) => r.checks.push({ ok: true, msg });
  let client = null;

  try {
    await page.goto(URL, { waitUntil: "load" });
    await page.waitForSelector("#menu:not(.hidden)", { visible: true });

    const menu = await page.evaluate(() => {
      const panel = document.getElementById("menu").querySelector(".panel");
      const p = panel.getBoundingClientRect();
      return {
        l: p.left, t: p.top, r: p.right, b: p.bottom,
        fits: p.top >= -1 && p.left >= -1 && p.right <= innerWidth + 1 && p.bottom <= innerHeight + 1,
        scrolls: panel.scrollHeight > panel.clientHeight + 2,
      };
    });
    menu.fits ? ok("menu panel fits viewport") : fail("menu panel does NOT fit: " + JSON.stringify(menu));
    !menu.scrolls ? ok("menu fits without scrolling") : fail("menu panel needs scrolling on this viewport");

    await page.type("#name", "uiTester");
    await page.click("#play");
    await page.waitForSelector("#hud:not(.hidden)", { visible: true, timeout: 10000 });

    // Portrait phones are told to rotate; the hint must cover the game.
    let rotated = false;
    if (vp.mobile && vp.height > vp.width) {
      const rot = await page.evaluate(() => ({
        shown: !document.getElementById("rotateHint").classList.contains("hidden"),
        menuHidden: document.getElementById("menu").classList.contains("hidden"),
      }));
      rot.shown ? ok("rotate hint shown in portrait") : fail("rotate hint missing in portrait");
      rot.menuHidden ? ok("menu hidden after play") : fail("menu still visible after play");
      await page.setViewport({ width: vp.height, height: vp.width, isMobile: true, hasTouch: true });
      await new Promise((res) => setTimeout(res, 600));
      const rotHidden = await page.evaluate(() =>
        document.getElementById("rotateHint").classList.contains("hidden"));
      rotHidden ? ok("rotate hint hides in landscape") : fail("rotate hint still shown in landscape");
      rotated = true;
    }

    client = await page.createCDPSession();
    let steering = null;
    const w = rotated ? vp.height : vp.width;
    const h = rotated ? vp.width : vp.height;
    if (vp.mobile) {
      const jx = Math.round(w * 0.35);
      const jy = Math.round(h * 0.55);
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: jx, y: jy }] });
      steering = () => steerCircle(client, jx, jy, 34, 400, 4);
      await steering();
      await steering();
    } else {
      steering = () => steerMouse(page, 400, 4);
      await steering();
      await steering();
    }

    let stateAfter = await joinAndStabilize(page, vp.mobile);
    if (stateAfter.deadShown || stateAfter.connShown) {
      await steering();
      stateAfter = await joinAndStabilize(page, vp.mobile);
    }
    if (stateAfter.connShown) {
      fail("connection lost during test");
    } else if (stateAfter.deadShown) {
      fail("player kept dying to bots during test");
    } else {
      ok("player alive at measure time");
    }

    await steering();
    await steering();
    const targetRows = 3; // leaderboard is top-3 everywhere
    for (let i = 0; i < 8; i++) {
      const rows = await page.evaluate(() => document.getElementById("boardRows").children.length);
      if (rows >= targetRows) break;
      await steering();
      await new Promise((res) => setTimeout(res, 500));
    }
    await steering();

    // Bots may have squished the test snake during the settle loop; respawn
    // so the layout measure runs on a live HUD.
    const pre = await page.evaluate(() => ({
      hud: !document.getElementById("hud").classList.contains("hidden"),
      dead: !document.getElementById("death").classList.contains("hidden"),
    }));
    if (!pre.hud && pre.dead) {
      await page.click("#respawn");
      await page.waitForSelector("#hud:not(.hidden)", { visible: true, timeout: 10000 });
      await steering();
    }

    const hud = await page.evaluate(() => {
      const hudVisible = !document.getElementById("hud").classList.contains("hidden");
      const ids = ["ping", "score", "board", "minimapWrap", "killfeed"];
      const rects = {};
      const bad = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        const b = el.getBoundingClientRect();
        rects[id] = { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
        const empty = id === "killfeed" && el.children.length === 0;
        if (!empty && (b.width <= 0 || b.height <= 0)) bad.push(id + ":zero-size");
        if (b.left < -1 || b.top < -1 || b.right > innerWidth + 1 || b.bottom > innerHeight + 1)
          bad.push(id + ":out-of-bounds");
      }
      const overlaps = [];
      const keys = Object.keys(rects);
      for (let i = 0; i < keys.length; i++)
        for (let j = i + 1; j < keys.length; j++) {
          const A = rects[keys[i]], B = rects[keys[j]];
          if (A.l < B.r - 2 && A.r > B.l + 2 && A.t < B.b - 2 && A.b > B.t + 2)
            overlaps.push([keys[i], keys[j]]);
        }
      const cv = document.getElementById("game").getBoundingClientRect();
      const rows = document.getElementById("boardRows").children.length;
      const board = document.getElementById("board");
      const mm = document.getElementById("minimapWrap").getBoundingClientRect();
      const bw = document.getElementById("backWrap").getBoundingClientRect();
      const kfEl = document.getElementById("killfeed").getBoundingClientRect();
      const bd = document.getElementById("board").getBoundingClientRect();
      return {
        rects, bad, overlaps, hudVisible,
        canvasFills: cv.width >= innerWidth - 1 && cv.height >= innerHeight - 1,
        rows,
        boardScrolls: board.scrollHeight > board.clientHeight + 2,
        layout: {
          mmTopLeft: mm.width === 0 || (mm.top < innerHeight / 2 && mm.left < innerWidth / 2),
          boardTopRight: bd.top < 90 && bd.right > innerWidth - 20,
          backNextToBoard: bw.top < 90 && bw.right < bd.left && bw.right > innerWidth - 200,
          kfTopCenter: kfEl.top < 100 && Math.abs((kfEl.left + kfEl.right) / 2 - innerWidth / 2) < 140,
        },
      };
    });

    hud.hudVisible ? ok("player alive at measure") : fail("player dead at measure time");
    hud.bad.length === 0 ? ok("HUD all in bounds") : fail("HUD out-of-bounds: " + hud.bad.join(", "));
    hud.overlaps.length === 0 ? ok("HUD no overlaps") : fail("HUD overlaps: " + JSON.stringify(hud.overlaps));
    hud.canvasFills ? ok("canvas fills viewport") : fail("canvas does not fill viewport");
    if (vp.mobile) {
      hud.rows === 3 ? ok("leaderboard shows top 3") : fail("leaderboard rows != 3: " + hud.rows);
      hud.layout.mmTopLeft ? ok("minimap top-left") : fail("minimap not top-left");
      hud.layout.boardTopRight ? ok("leaderboard top-right") : fail("leaderboard not top-right");
      hud.layout.backNextToBoard ? ok("hamburger left of leaderboard") : fail("hamburger not left of leaderboard");
      hud.layout.kfTopCenter ? ok("killfeed top-center") : fail("killfeed not top-center");
    } else {
      hud.rows > 0 ? ok("leaderboard has " + hud.rows + " rows") : fail("leaderboard is empty");
    }
    hud.boardScrolls
      ? r.checks.push({ ok: true, msg: "board scrolls internally (rows " + hud.rows + ") [info]" })
      : ok("board shows all rows");
    r.hud = hud.rects;

    if (vp.mobile) {
      const joy = await page.evaluate(() => {
        const hudHidden = document.getElementById("hud").classList.contains("hidden");
        const b = document.getElementById("joystickBase").getBoundingClientRect();
        return {
          hudHidden,
          shown: !document.getElementById("joystickBase").classList.contains("hidden"),
          l: b.left, t: b.top, r: b.right, b: b.bottom,
          inBounds: b.left >= -1 && b.top >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1,
        };
      });
      const mmRect = hud.rects.minimapWrap;
      const overMinimap = mmRect && joy.l < mmRect.r - 4 && joy.r > mmRect.l + 4 && joy.t < mmRect.b - 4 && joy.b > mmRect.t + 4;
      if (joy.hudHidden) {
        r.checks.push({ ok: true, msg: "joystick checks skipped (player dead)" });
      } else {
        joy.shown ? ok("joystick appears on touch") : fail("joystick did not appear");
        joy.inBounds ? ok("joystick in bounds") : fail("joystick out of bounds: " + JSON.stringify(joy));
        !overMinimap ? ok("joystick clear of minimap") : fail("joystick overlaps minimap: " + JSON.stringify(joy));
      }
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

      await page.evaluate(() => {
        const feed = document.getElementById("killfeed");
        feed.innerHTML = "";
        for (let i = 0; i < 5; i++) {
          const d = document.createElement("div");
          d.className = "kf-item";
          d.innerHTML = `<span style="color:#FF5722">TesterX</span> » <span style="color:#00C2D1">VictimY</span>`;
          feed.appendChild(d);
        }
      });
      const kf = await page.evaluate(() => {
        const b = document.getElementById("killfeed").getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, b: b.bottom,
          inBounds: b.left >= -1 && b.top >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1 };
      });
      kf.inBounds ? ok("5-item killfeed in bounds") : fail("killfeed out of bounds: " + JSON.stringify(kf));
      const kfOverlap = await page.evaluate(() => {
        const kf = document.getElementById("killfeed").getBoundingClientRect();
        for (const id of ["board", "minimapWrap"]) {
          const b = document.getElementById(id).getBoundingClientRect();
          if (kf.left < b.right - 2 && kf.right > b.left + 2 && kf.top < b.bottom - 2 && kf.bottom > b.top + 2) return id;
        }
        return null;
      });
      kfOverlap ? fail("killfeed overlaps " + kfOverlap) : ok("killfeed clear of board/minimap");

      const boost = await page.evaluate(() => {
        const el = document.getElementById("boostBtn");
        const cs = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        const overlaps = [];
        for (const id of ["ping", "score", "board", "minimapWrap", "killfeed", "joystickBase"]) {
          const other = document.getElementById(id).getBoundingClientRect();
          if (other.width > 0 && other.height > 0 &&
              b.left < other.right - 2 && b.right > other.left + 2 &&
              b.top < other.bottom - 2 && b.bottom > other.top + 2) overlaps.push(id);
        }
        return {
          shown: cs.display !== "none" && b.width > 0,
          inBounds: b.left >= -1 && b.top >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1,
          overlaps,
        };
      });
      boost.shown ? ok("boost button appears on touch") : fail("boost button missing on touch");
      boost.inBounds ? ok("boost button in bounds") : fail("boost button out of bounds");
      boost.overlaps.length === 0
        ? ok("boost button clear of HUD")
        : fail("boost button overlaps: " + JSON.stringify(boost.overlaps));
    }
  } catch (e) {
    const st = await page.evaluate(() => ({
      hud: !document.getElementById("hud").classList.contains("hidden"),
      death: !document.getElementById("death").classList.contains("hidden"),
      conn: !document.getElementById("connLost").classList.contains("hidden"),
      joining: !document.getElementById("joining").classList.contains("hidden"),
      rotate: !document.getElementById("rotateHint").classList.contains("hidden"),
      menu: !document.getElementById("menu").classList.contains("hidden"),
    })).catch(() => ({}));
    fail("exception: " + e.message + " state=" + JSON.stringify(st));
  }
  results.push(r);
  try { await page.close(); } catch {}
}

await browser.close();
let failed = 0;
for (const r of results) {
  console.log(`\n=== ${r.name} (${r.vw}x${r.vh}) ===`);
  for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.msg}`);
  if (r.checks.some((c) => !c.ok)) failed++;
}
console.log(`\n${results.length - failed}/${results.length} viewports clean`);
process.exit(failed === 0 ? 0 : 1);
