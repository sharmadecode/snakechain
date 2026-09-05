import puppeteer from "puppeteer-core";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const URL = process.env.TEST_URL ?? "http://127.0.0.1:8787/?nogate=1";

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
  let lastX = cx;
  let lastY = cy;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    lastX = cx + Math.cos(a) * radius;
    lastY = cy + Math.sin(a) * radius;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: lastX, y: lastY }],
    });
    await new Promise((res) => setTimeout(res, t / n));
  }
  return { lastX, lastY };
}

async function steerMouse(page, t, n) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const vp = page.viewport();
    await page.mouse.move(vp.width / 2 + Math.cos(a) * 200, vp.height / 2 + Math.sin(a) * 200);
    await new Promise((res) => setTimeout(res, t / n));
  }
}

async function joinAndStabilize(page) {
  let hud;
  for (let attempt = 0; attempt < 4; attempt++) {
    hud = await page.evaluate(() => ({
      hudShown: !document.getElementById("hud").classList.contains("hidden"),
      deadShown: !document.getElementById("death").classList.contains("hidden"),
      connShown: !document.getElementById("connLost").classList.contains("hidden"),
    }));
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

    // Shared browser profile: wipe the previous viewport's saved nickname so
    // every run starts from a truly empty form (else play auto-joins).
    await page.evaluate(() => {
      localStorage.clear();
      const nameEl = document.getElementById("name");
      if (nameEl) nameEl.value = "";
    });

    // Menu deck: fits the viewport without internal clipping.
    const menu = await page.evaluate(() => {
      const deck = document.querySelector(".arcade-deck");
      const d = deck.getBoundingClientRect();
      const overflowY = getComputedStyle(deck).overflowY;
      return {
        l: d.left, t: d.top, r: d.right, b: d.bottom,
        fits: d.top >= -1 && d.left >= -1 && d.right <= innerWidth + 1 && d.bottom <= innerHeight + 1,
        // Content taller than the deck is fine when it can scroll; only
        // hidden overflow (inaccessible content) is a failure.
        clips: deck.scrollHeight > deck.clientHeight + 2 && overflowY !== "auto" && overflowY !== "scroll",
      };
    });
    menu.fits ? ok("menu deck fits viewport") : fail("menu deck does NOT fit: " + JSON.stringify(menu));
    !menu.clips ? ok("menu deck shows all content") : fail("menu deck clips content on this viewport");

    // The global .hidden rule must actually hide non-overlay elements:
    // ghost joystick rings / HUD bleed-through were a real bug.
    const hiddenWorks = await page.evaluate(() => {
      const hud = document.getElementById("hud");
      const joy = document.getElementById("joystickBase");
      return {
        hudHidden: getComputedStyle(hud).display === "none",
        joyHidden: getComputedStyle(joy).display === "none",
      };
    });
    hiddenWorks.hudHidden ? ok("HUD hidden while menu open") : fail("HUD visible behind menu (.hidden broken)");
    if (vp.mobile) {
      hiddenWorks.joyHidden ? ok("joystick hidden until touch") : fail("ghost joystick ring visible (.hidden broken)");
    }

    // Nickname validation: empty name must not join, shows inline error.
    await page.click("#play");
    const noJoin = await page.evaluate(() => ({
      err: !document.getElementById("nameError").classList.contains("hidden"),
      stillMenu: !document.getElementById("menu").classList.contains("hidden"),
    }));
    noJoin.err && noJoin.stillMenu ? ok("empty nickname blocked with inline error") : fail("empty nickname not blocked: " + JSON.stringify(noJoin));

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
    let lastTouch = null; // last steering touch position (for a proper touchEnd)
    const w = rotated ? vp.height : vp.width;
    const h = rotated ? vp.width : vp.height;
    if (vp.mobile) {
      const jx = Math.round(w * 0.35);
      const jy = Math.round(h * 0.55);
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: jx, y: jy }] });
      lastTouch = { x: jx, y: jy };
      steering = async () => {
        const p = await steerCircle(client, jx, jy, 34, 400, 4);
        lastTouch = { x: p.lastX, y: p.lastY };
      };
      await steering();
      await steering();
    } else {
      steering = () => steerMouse(page, 400, 4);
      await steering();
      await steering();
    }

    let stateAfter = await joinAndStabilize(page);
    if (stateAfter.deadShown || stateAfter.connShown) {
      await steering();
      stateAfter = await joinAndStabilize(page);
    }
    if (stateAfter.connShown) {
      fail("connection lost during test");
    } else {
      ok("still connected at measure time");
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
      const ids = ["pingBadge", "scoreLen", "board", "minimap", "killfeed", "boostBtn"];
      const rects = {};
      const bad = [];
      for (const id of ids) {
        const el = document.getElementById(id);
        const b = el.getBoundingClientRect();
        rects[id] = { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height };
        const empty = id === "killfeed" && el.children.length === 0;
        // display:none is a by-design state (boostBtn hides on fine-pointer
        // desktops where Space/LMB boosts) — not a layout bug.
        const designedHidden = getComputedStyle(el).display === "none";
        if (!empty && !designedHidden && (b.width <= 0 || b.height <= 0)) bad.push(id + ":zero-size");
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
      const mm = document.getElementById("minimap").getBoundingClientRect();
      const kfEl = document.getElementById("killfeed").getBoundingClientRect();
      const bd = document.getElementById("board").getBoundingClientRect();
      return {
        rects, bad, overlaps, hudVisible,
        canvasFills: cv.width >= innerWidth - 1 && cv.height >= innerHeight - 1,
        rows,
        layout: {
          mmTopLeft: mm.width === 0 || (mm.top < innerHeight / 2 && mm.left < innerWidth / 2),
          boardTopRight: bd.top < 90 && bd.right > innerWidth - 20,
          kfTopCenter: kfEl.top < 100 && Math.abs((kfEl.left + kfEl.right) / 2 - innerWidth / 2) < 140,
        },
      };
    });

    hud.hudVisible ? ok("player alive at measure") : fail("player dead at measure time");
    hud.bad.length === 0 ? ok("HUD all in bounds") : fail("HUD out-of-bounds: " + hud.bad.join(", "));
    hud.overlaps.length === 0 ? ok("HUD no overlaps") : fail("HUD overlaps: " + JSON.stringify(hud.overlaps));
    hud.canvasFills ? ok("canvas fills viewport") : fail("canvas does not fill viewport");
    hud.layout.mmTopLeft ? ok("minimap top-left") : fail("minimap not top-left");
    hud.layout.boardTopRight ? ok("leaderboard top-right") : fail("leaderboard not top-right");
    hud.layout.kfTopCenter ? ok("killfeed top-center") : fail("killfeed not top-center");
    hud.rows > 0 ? ok("leaderboard has " + hud.rows + " rows") : fail("leaderboard is empty");
    r.hud = hud.rects;

    if (vp.mobile) {
      const joy = await page.evaluate(() => {
        const b = document.getElementById("joystickBase").getBoundingClientRect();
        return {
          shown: !document.getElementById("joystickBase").classList.contains("hidden"),
          l: b.left, t: b.top, r: b.right, b: b.bottom,
          inBounds: b.left >= -1 && b.top >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1,
        };
      });
      const mmRect = hud.rects.minimap;
      const overMinimap = mmRect && joy.l < mmRect.r - 4 && joy.r > mmRect.l + 4 && joy.t < mmRect.b - 4 && joy.b > mmRect.t + 4;
      joy.shown ? ok("joystick appears on touch") : fail("joystick did not appear");
      joy.inBounds ? ok("joystick in bounds") : fail("joystick out of bounds: " + JSON.stringify(joy));
      !overMinimap ? ok("joystick clear of minimap") : fail("joystick overlaps minimap: " + JSON.stringify(joy));
      // Release with the lifted point listed — an empty touchPoints list
      // produces a touchend with no changedTouches, leaving the stick stuck.
      await client.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [lastTouch ?? { x: w / 2, y: h / 2 }],
      });
      await new Promise((res) => setTimeout(res, 250));
      // CDP occasionally drops the changedTouches detail; when that happens,
      // touchcancel takes the same app path (handleTouchEnd) and completes
      // the release. Skipped when the touchEnd already landed.
      let stickHidden = await page.evaluate(() =>
        document.getElementById("joystickBase").classList.contains("hidden"));
      if (!stickHidden) {
        try {
          await client.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        } catch { /* touch already released — nothing to cancel */ }
        await new Promise((res) => setTimeout(res, 250));
      }

      // Killfeed entries are individually removed; check a full feed stays in bounds.
      await page.evaluate(() => {
        const feed = document.getElementById("killfeed");
        feed.innerHTML = "";
        for (let i = 0; i < 3; i++) {
          const d = document.createElement("div");
          d.className = "kf-item";
          d.innerHTML = `YOU ELIMINATED <span class="v">Victim${i}</span>`;
          feed.appendChild(d);
        }
      });
      const kf = await page.evaluate(() => {
        const b = document.getElementById("killfeed").getBoundingClientRect();
        return { l: b.left, t: b.top, r: b.right, b: b.bottom,
          inBounds: b.left >= -1 && b.top >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1 };
      });
      kf.inBounds ? ok("multi-item killfeed in bounds") : fail("killfeed out of bounds: " + JSON.stringify(kf));
      const kfOverlap = await page.evaluate(() => {
        const kf = document.getElementById("killfeed").getBoundingClientRect();
        for (const id of ["board", "minimap"]) {
          const b = document.getElementById(id).getBoundingClientRect();
          if (kf.left < b.right - 2 && kf.right > b.left + 2 && kf.top < b.bottom - 2 && kf.bottom > b.top + 2) return id;
        }
        return null;
      });
      kfOverlap ? fail("killfeed overlaps " + kfOverlap) : ok("killfeed clear of board/minimap");

      // Landscape control-zone checks: the boost button must be a real touch
      // target in the bottom-right thumb zone, and tapping it must not spawn
      // the steering joystick (steering zone = left 75% of the screen).
      // `w`/`h` reflect the effective (post-rotation) orientation.
      if (w > h) {
        const boost = await page.evaluate(() => {
          const el = document.getElementById("boostBtn");
          const b = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const joy = document.getElementById("joystickBase").getBoundingClientRect();
          return {
            w: b.width, h: b.height,
            top: b.top, right: b.right, bottom: b.bottom,
            touchAction: cs.touchAction,
            joyHidden: document.getElementById("joystickBase").classList.contains("hidden"),
            joyOverlapsBoost: b.left < joy.right - 2 && b.right > joy.left + 2 &&
              b.top < joy.bottom - 2 && b.bottom > joy.top + 2,
            inBottomRightHalf: b.left > innerWidth / 2 && b.top > innerHeight / 2,
          };
        });
        boost.w >= 60 && boost.h >= 60 ? ok("boost target >= 60px") : fail("boost target too small: " + boost.w + "x" + boost.h);
        boost.inBottomRightHalf ? ok("boost in bottom-right thumb zone") : fail("boost outside thumb zone");
        boost.touchAction === "none" ? ok("boost ignores browser gestures") : fail("boost touch-action not locked");
        boost.joyHidden ? ok("joystick hidden while idle") : fail("joystick visible while idle");

        // Tap the boost button: must NOT activate the steering joystick.
        const bc = await page.evaluate(() => {
          const b = document.getElementById("boostBtn").getBoundingClientRect();
          return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
        });
        await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bc.x, y: bc.y }] });
        await new Promise((res) => setTimeout(res, 200));
        const boostTap = await page.evaluate(() => ({
          joySpawned: !document.getElementById("joystickBase").classList.contains("hidden"),
          boostActive: document.getElementById("boostBtn").classList.contains("active"),
        }));
        !boostTap.joySpawned ? ok("boost tap does not spawn joystick") : fail("boost tap spawned the steering joystick");
        boostTap.boostActive ? ok("boost press activates button") : fail("boost press not registered");
        await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: bc.x, y: bc.y }] });

        // Tap the left half: joystick must appear AT the touch point.
        const jx2 = Math.round(w * 0.3);
        const jy2 = Math.round(h * 0.6);
        await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: jx2, y: jy2 }] });
        await new Promise((res) => setTimeout(res, 200));
        const joyAt = await page.evaluate(() => {
          const shown = !document.getElementById("joystickBase").classList.contains("hidden");
          const b = document.getElementById("joystickBase").getBoundingClientRect();
          return { shown, cx: (b.left + b.right) / 2, cy: (b.top + b.bottom) / 2 };
        });
        joyAt.shown && Math.abs(joyAt.cx - jx2) < 8 && Math.abs(joyAt.cy - jy2) < 8
          ? ok("joystick appears at touch point")
          : fail("joystick misplaced: " + JSON.stringify({ want: [jx2, jy2], got: [joyAt.cx, joyAt.cy] }));
        await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: jx2, y: jy2 }] });
      }
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
