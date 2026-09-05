# SnakeChain.io — Phase 1 & 2: Chain Physics + Sprite Renderer

Status: **IMPLEMENTED** — verified with `tsc --noEmit` on both sides. No processes or
ports touched during development. This document is the complete technical record of
what changed, why, how it works, and how to tune it.

---

# PHASE 1 — Follow-the-leader chain physics ("real snake" motion)

## 1.1 The problem

The old body model was a **path trail**: `px/py` recorded every position the head had
been (one point per 10 units of travel). The body was literally frozen steering
history — steer a circle and that circle persisted until cropped off the tail. Real
snakes (and slither.io) don't work that way: the body **compacts** through turns,
cuts corners, and relaxes into a smooth curve when you straighten out.

## 1.2 The new model — follow-the-leader chain

The body is now **N segments** (`px[0]` = head, `px[N-1]` = tail tip). Every tick:

```
1. Head moves freely        (turn-rate limits unchanged — anti-cheat intact)
2. For each segment i ≥ 1:
       d  = distance(segment i, segment i-1)
       if d > LINK_SPACING:
           segment i := segment(i-1) + normalize(segment i − segment(i-1)) × LINK_SPACING
       (segments CLOSER than spacing are left alone → tight turns bunch the inner side)
3. Segment count chases targetLen:
       desired = clamp(round(targetLen / LINK_SPACING), 4, MAX_POINTS)
       grow ≤ CHAIN_GROW_PER_TICK/tick (duplicate tail segment — it unfurls
               naturally as its predecessor pulls away)
       shrink instantly to desired (boost drain ≈ 0.6 segments/sec → smooth)
```

Why this produces slither-like motion:
- **Corner cutting**: each segment takes a straight chord to the ring around its
  predecessor — curves become inscribed polygons that tighten over successive ticks.
- **Loop compaction**: in a tight circle, inner-rail segments sit closer than spacing
  and stop moving; when you exit the turn they get re-stretched straight — **the loop
  dissolves into the body** instead of persisting as history.
- **Determinism**: the ring snap is a pure function of positions — server and client
  run byte-identical math, so prediction stays tight.

## 1.3 Data-structure migration map

| Concept | OLD (path trail) | NEW (chain) |
|---|---|---|
| `px[0]` | First trail point BEHIND the head | **The head itself** (`px[0] === x`) |
| Array meaning | Steering history | Physical segments |
| Length source | `totalLen` accumulated from path arcs | Segment count × spacing (`targetLen` drives count) |
| `crop()` | Popped tail points when path exceeded targetLen | **Deleted** — count management replaces it |
| `eat()` tail extension | Instantly appended straight-line points | **Deleted** — `targetLen` rises; segments grow organically over ~10 ticks |
| Growth visuals | Straight-line tail spikes | Tail unfurls as the chain pulls away |
| `unshift()` cost | O(n) memmove every ~2 ticks | **Eliminated** — head writes in place, tail grows via `push` (O(1)) |

## 1.4 Server ripple (all traced)

| Site | Change |
|---|---|
| `player.ts spawn()` | Builds straight chain, `px[0] = head`; no `totalLen` |
| `player.ts move()` | Head writes `px[0]`; follow pass; `adjustChainLength()` |
| `player.ts eat()` | Clamps `targetLen` to bot cap AND `MAX_POINTS × spacing` (leaderboard can never show unreachable length — old divergence bug class removed) |
| `player.ts crop()/extendTail` | Deleted |
| `session.ts updateSegsInGrid()` | Old "neck" special-case (`i === -1`, head≠px[0]) removed — pairs `(i, i+1)` now span the entire body including head→neck |
| `session.ts` collision lookup | `seg.i === -1` branches removed (indices are now plain 0-based pairs) |
| Head-to-head exemption | Still `seg.i <= 0` — pair 0 IS the head capsule, semantics preserved |
| `bot.ts` | Zero changes required (reads `px/py/targetLen` — all still valid; heads now included in threat scans, which is strictly safer AI) |
| `bodyRow()` streaming | Unchanged — adaptive stride over segments, whole body always streamed |
| Drops / boost pellets | Read tail tip exactly as before |

New config constants (server/src/config.ts):
- `CHAIN_GROW_PER_TICK = 3` — max segments appended per tick (a +300 eat animates in ~0.33s)
- `MIN_CHAIN_SEGS = 4`
- `POINT_SPACING` (existing, =10) repurposed as **link spacing** — documented in-place

## 1.5 Client mirror (web/src/state.ts)

- `makePlayer()` seeds a straight chain sized from the first row's length (velocity
  seeding from the previous fix retained).
- `update()` runs the **identical ring-snap** on the interpolated head each frame and
  manages count toward `pl.len` (≤3 segments/frame growth). Incremental `pl.total`
  maintained during the follow pass so render-time stitching stays exact.
- `extendTail()` deleted; bare `1200` literals replaced by `MAX_LOCAL_POINTS = 900`
  (headroom above server's 800).
- Authoritative `b` snapshots continue to stream the far tail; renderer stitches
  local chain + authority exactly as before (cumulative-distance walk tolerates
  variable spacing).

## 1.6 Impact summary (Render free tier)

| Resource | Effect |
|---|---|
| Egress | **Zero change** (message shapes identical) |
| CPU/tick | **Equal or better** (O(n) memmove eliminated; follow pass is cheap in-place math) |
| RAM | Neutral |
| Security surface | **Zero change** — no new messages, authority unchanged, turn-clamp anti-cheat intact |
| Gameplay texture | Bodies cut corners → tight-circle wraps slightly harder (slither.io-fair) |

---

# PHASE 2 — Sprite pipeline renderer

## 2.1 Goal

Richer material quality at LOWER per-frame cost: bake expensive raster work
(gradients, borders, shading strips, glows) into per-color sprites ONCE, then stamp
them with a single `drawImage` per instance.

## 2.2 What's baked now

| Asset | Contents (built once at first frame) | Per-frame cost |
|---|---|---|
| **Block sprites ×12** (96px) | Vertical-lit rounded face (lighten→base→darken gradient), 6px ink border, top bevel strip, bottom AO strip | 1 `drawImage` (scaled to block size, rotated to segment tangent) — replaces ~8 path ops per block |
| **Food sprites ×12** (from round 2) | Glow halo, drop shadow, face, bevel | 1 `drawImage` |
| **Aura sprites ×12** (new) | Soft radial color bloom | 1 `drawImage` under the player's own head (identity readability + premium feel) |

Kept from earlier rounds: contact-shadow stroke under every snake (one path per
snake), outside-arena dimming, world-aligned patterned floor, CSS vignette.

## 2.3 Rendering flow per snake (after Phase 1+2)

```
contact shadow stroke  →  for each block (tail→head): translate/rotate/drawImage
                        →  head: vector-drawn (dynamic eyes) + highlight + aura(self)
```

Blocks inherit smooth tangents from the chain (Phase 1), so the stamped sprites
follow organic curves — motion and material upgrade each other.

## 2.4 Tuning guide

All feel knobs live in `server/src/config.ts`:

| Symptom | Knob |
|---|---|
| Loops compact too slowly | lower `POINT_SPACING` (e.g. 9) — finer links bend faster |
| Body feels stiff/rigid | raise `CHAIN_GROW_PER_TICK`; consider a softened ring blend in `Player.move` |
| Growth feels instant/slow | `CHAIN_GROW_PER_TICK` (3 ≈ 0.33s for a +300 windfall) |
| Snakes too long on screen | `MAX_POINTS` (800 segments = 8000u max) |
| Thickness curve | `THICK_MIN/THICK_MAX/THICK_GROW_AT` (maxed at len 800 by design) |

Client mirror constants that MUST match: `SPACING` (=10) and `MAX_LOCAL_POINTS`
(≥ server `MAX_POINTS`) in `web/src/state.ts`.

## 2.5 Verification checklist

- [x] `npx tsc --noEmit` — server exit 0
- [x] `npx tsc --noEmit` — web exit 0
- [x] Static trace: spawn → move → eat → boost-drain → die → drops → respawn (both sides)
- [x] Static trace: grid insert/remove lifecycle with new pair indexing
- [x] Static trace: client chain ↔ authoritative `b` snapshot stitching
- [x] Ripple audit: every reader of `px/py` (session, bots, safeSpawn, drops, streaming)
- [ ] Live playtest (requires running the game — left to the operator):
      circle-then-straight should visibly compact; spawns clear; no invisible kills;
      60fps on mid-range hardware.

---

# ADVERSARIAL DEEP-DIVE (post-implementation review ledger)

Second-pass review of the shipped chain model, hunting bugs, exploits and edge
cases as an independent auditor would. Result: **2 real issues fixed, 1 dead-code
removal, 11 areas verified sound, 3 accepted limitations documented with levers**
— plus one realism enhancement implemented from the findings (D4 below).

## D. Realism enhancement implemented

| # | Item | Detail |
|---|---|---|
| D4 | **Serpentine cruise wave → REMOVED** | A cosmetic traveling sine wave along the body was added (slither-style undulation), then **removed entirely by operator decision** after two playtest rounds: even with a tail-safe fade it left residual motion on the small tapered end blocks. Final state: body motion comes PURELY from the follow-the-leader chain physics (loop compaction + corner cutting), zero cosmetic displacement. The chain model itself is retained — that is the "real snake" circle-compaction behavior. If any tail motion remains visible in playtesting, it is chain-mechanical (growth-unfurl after eats, or the authority-stitch seam) and will be traced separately. |
| D5 | **Eat-time tail jump — FINAL resolution** | Root cause: the renderer's tail-stitch spliced ~100ms-stale server samples onto SELF's locally-simulated chain whenever a big eat opened a deficit, making your own tail jump/bend. **Final rule: SELF is NEVER stitched (pure organic local growth — new blocks slide out of your own tail); REMOTE snakes stitch on any deficit (>20u) so their shapes stay true.** An intermediate attempt (short seeds + authority-completed remotes) was tried and REVERTED after playtest: without snapshot interpolation it rendered whole remote bodies from sparse stale samples → arena-wide jitter. Lesson recorded for this engine: remote bodies need full-length locally-simulated chains for smoothness; stitching is only a truthing patch. |

## D. Fixed during this review

| # | Finding | Severity | Fix |
|---|---|---|---|
| D1 | `Math.hypot` in the follow pass — V8's hypot is several× slower than `sqrt(d²)`; this loop runs per-segment-per-tick server-side AND per-frame client-side. At arena cap (~80k segments) that's measurable ms/tick burned for nothing | MEDIUM (perf) | Squared-distance gate + sqrt only on actual snaps. Formula kept IDENTICAL server/client (`spacing / sqrt(d²)`) so prediction parity is preserved. Applied to `player.ts` and `state.ts` |
| D2 | `dropPositions()` double-counted the head after the chain migration (index 0 pellet AND the explicit head pellet overlapped at the kill spot) | LOW | Loop now starts at segment 1 |
| D3 | Dead getters `segmentCount`/`lengthUnits` left behind by the migration (semantic change made them misleading) | LOW | Removed |

## D. Verified sound (each traced end-to-end)

1. **Division-by-zero / NaN**: ring snap is gated on `d² > spacing²`, so zero-length (duplicate tail) pairs can never divide. NaN can't enter (inputs finite-validated upstream; food values are integers).
2. **Growth/shrink bounds**: `adjustChainLength` clamps to `[MIN_CHAIN_SEGS=4, MAX_POINTS=800]`; BOOST_MIN_LENGTH(45)→desired 5 ≥ floor ✓; START_LENGTH(35)→4 ✓. Client growth ≤3/frame vs server ≤3/tick(30Hz) — client can only LAG, never lead authority (see invariant below).
3. **Stitch-safety invariant**: client count derives from the SAME formula on the SAME `tlen`, and bunched chains make local arc-length UNDER-estimate — under-estimation is the safe direction (authority overlaps slightly); over-estimation (which would create a visible gap) is structurally impossible.
4. **Zero-length segments**: duplicate tail segments produce zero-length grid capsules → `segmentCells(a,a)` yields one cell; `pointSegDist2` handles `len2===0`; renderer block-stepping skips sub-unit chords (`segLen < 1e-4`). All three consumers verified.
5. **Head-to-head semantics preserved**: pair index 0 IS the head capsule, so the legacy `seg.i <= 0` exemption still means "actual head contact"; head-on ties still resolve via closing-speed.
6. **Self-collision** remains off (`item.p !== p`) — unchanged contract.
7. **Bot AI reads remain valid**: bounding-circle early-out uses `px.length × spacing` which OVER-estimates reach for bunched chains (safe direction); threat scans now include heads (index 0), strictly safer avoidance; `pathSafe`/intercept math unchanged and correct.
8. **Streaming budget**: adaptive-stride `bodyRow()` covers ALL segments of any length ≤ MAX_POINTS×spacing — the invisible-killer guarantee survives the model swap; worst chord error ~8u ≪ block size.
9. **Wall kill, respawn scheduling, pendingSpawns, despawn cleanup, kill credit/rank**: all read head position or `targetLen` — unaffected by chain semantics.
10. **Security surface unchanged**: no new inbound message types, no client-authoritative data added (client chain is prediction-only), turn-clamp anti-cheat intact, growth capped structurally (bots 500, humans 8000) so no resource-exhaustion vector via forced growth.
11. **Memory**: plain arrays with push/pop (amortized O(1)); capacity churn bounded by MAX_POINTS; no per-tick allocations introduced anywhere in the hot path (all math writes in place).

## D. Accepted limitations (documented, with tuning levers)

| Limitation | Why accepted | Lever if it bothers you in playtesting |
|---|---|---|
| Mid-body divergence during aggressive turns: local simulated chain can differ from authority between `b` snapshots (~100ms cadence); far tail always shows truth, seam sits at the stitch boundary | Same structural trade-off slither-class games make; errors concentrate near the recent-head region where the position follower keeps things tight | Raise body cadence `tickNo % 3` → `% 2` in session.ts broadcastState (~+50% body bytes) |
| Giant snake entering view shows a straight seeded chain for ~100ms until first authoritative body lands | Beats invisible/stub bodies; identical to pre-chain behavior | Seed from join-time interest radius instead of straight line (complexity not yet justified) |
| Hard ring snap = fully rigid stretch (no elastic give) | Determinism with the client mirror outweighs softness; snaps are ≤ one tick of head movement (~11u max) so they read as smooth at 30TPS | Introduce a blend factor toward the ring (must ship identically to BOTH sides in the same deploy) |

## D. Perf posture after fixes

- Server hot loop: squared-gate + conditional sqrt; no allocations; O(totalSegments) with tiny constant factor. Expected net-neutral-to-better vs the old path-trail model (the O(n) `unshift` memmove is gone).
- Client hot loop: same shape, bounded by VISIBLE players' local chains (≤ MAX_LOCAL_POINTS each) at 60fps — comfortably inside frame budget; adaptive-DPR watchdog remains the safety net.
- Egress/RAM/security: unchanged from the pre-implementation analysis (PHASES.md §1.6).

---

# FEATURE PACK — Tier 1 (implemented)

Four genre-proven features, designed around three constraints: zero extra network
messages (wire slots reused), all authority server-side, no hot-loop additions.

## F1 · Personal Best system (client-only)
`localStorage["blocks.stats"]`: bestLen / mostKills / games, parsed with strict
type guards. Menu shows a progression strip after the first game; the death screen
celebrates record breaks via a pop-in banner ("NEW PERSONAL BEST LENGTH") and the
MAX LENGTH card gains a "· PB n" suffix. Zero server cost.

## F2 · Skin patterns (activates the already-streamed patternIdx)
Six patterns baked as sprite VARIANTS (6 variants × 12 palette colors = 72 sprites,
built once): 0 solid · 1 stripes · 2 tail-fade · 3 spots · 4 dark bands (pairs) ·
5 ink accents (every 4th block). Per-block draw cost unchanged (one drawImage).
Menu gains a pattern pill row with mini canvas previews tinted by your head color;
selection persists in prefs and rides the existing join field `p`.
Bots already roll random patterns, so variety is visible immediately.

## F3 · Spawn protection (2s)
Server-authoritative window on spawn: protected snakes can neither kill nor be
killed (wall, body capsules AND head-on clashes all guarded; boost cancels it
instantly — no invulnerable rushing). State rides broadcast row slot 9 (previously
a constant placeholder "0") → zero protocol change; clients render a pulsing cream
shimmer outline around protected heads.

## F4 · Golden pellets
~1% of NATURAL food spawns are golden: amber cube ×1.35 scale, always-on pulsing
halo ring + two orbiting white glints, worth GOLDEN_VALUE=10 mass. Flag serialized
conditionally (`,1`) so ordinary food rows stay byte-identical for old clients.
Boost drops and death drops can never be golden (economy stays honest).

## Verification
- `tsc --noEmit` exit 0 both sides
- Server restarted (operator's own :8788 instance only) and healthy post-deploy
- Frontend serving all new UI elements (patternRow / menuStats / pbBanner verified in served HTML)

---

# FEATURE PACK — Tier 2 (implemented)

## T2-1 · Battle-Royale collapse (server-timed, zero new hot-loop cost)
The single arena now runs continuous BR rounds — no matchmaker/lobby changes needed:
- Wall target steps down ×0.82 every 25s (first collapse after 40s), eased at 90 u/s
- Floor = halfW 650 → 30s endgame hold → current #1 crowned **CHAMPION** (👑 banner broadcast) → wall re-expands → next round
- Food outside the collapsed zone is purged through the normal batched-removal path so the FOOD_CAP economy keeps feeding playable space
- Everything downstream adapts automatically: lethal wall, safeSpawn margins, food fill radius, bot wall-avoidance (`ctx.getHalfW()`), minimap scale, client wall rendering (`w[]` was already streamed every tick)
- Champion name is server-known; rendered via textContent (no XSS surface); validated + truncated client-side too

## T2-2 · Spectate-on-death (death-cam)
- `DeadStats` gains `killerId` (one int in the existing `dead` message)
- On death: camera glides to the killer (existing exponential smoothing; zoom follows their length); death overlay switches to a translucent "spectating" style (no blur) so the action stays watchable
- Cleared on respawn / ESC→lobby / disconnect; falls back gracefully if the killer dies or leaves view
- Server-authoritative fact — no trust or spoofing surface

## Verification
- `tsc --noEmit` exit 0 both sides; own :8788 instance restarted & healthy
- Live smoke test: join via frontend proxy → `hi` OK → state rows carry live `halfW`

---

# MODE SPLIT + FEEDBACK FIXES (post-Tier-2 playtest)

## M1 · BR is now a separate MODE — classic is the default main map
Two persistent arenas on one process (`Matchmaker` holds `classic` + `br`, each
with its own 20-bot population). Menu gains a CLASSIC / COLLAPSE picker above
PLAY; the choice persists and is sent as `mo` on every join (respawns stay in
the same arena). Classic = constant slither-io style map; collapse rounds run
only in "br" sessions (`brTick` no-ops elsewhere). `/health` aggregates both
arenas and reports per-arena detail.

## M2 · "Bite didn't register" — spawn-protection windows were the ghost
2s protection on constantly-respawning bots meant you were often biting an
invulnerable, harmless ghost. Fixes: window cut to **1.2s**, and EATING now
breaks the shield instantly ("shield breaks on action"). Boost-break retained.

## M3 · Jitter fix — remote tail-stitching disabled
The >20u-deficit stitch fired whenever a remote snake ate, splicing sparse
stale samples onto their tails → visible snapping. Local full-length simulation
converges to truth by itself and is smooth, so remote stitching is DISABLED
(one-line lever in render.ts documents how to re-enable). Self was already
never stitched. Net result: smoothest known configuration across all snakes.

## Verification
`tsc --noEmit` exit 0 both sides · own instance restarted · simultaneous dual-mode
join smoke test passed (classic id=41 / br id=42) · /health per-arena detail live

---

# ANDROID PARITY PASS (native Kotlin app brought level with the web build)

The `android/` native app now matches the mobile-browser experience feature-for-feature:

- **Chain physics**: follow-the-leader simulation ported 1:1 (ring-snap pass, organic
  growth extending out of the tail, count management) — Android bodies now match
  server truth instead of rendering old trail-model shapes.
- **Modes**: CLASSIC / COLLAPSE picker in the menu; `mo` sent on every join;
  respawns stay in the same arena.
- **Spectate death-cam**: parses `killerId`, camera glides to the killer, and a
  `view{tg}` message keeps server interest centered on them (no more vanishing).
- **Boost glow**: additive per-block bloom in each block's own chain color + head
  bloom (pre-rendered bitmaps, PorterDuff ADD — paid only while boosting). Self is
  exact input; remotes infer via velocity hysteresis (band 215–255).
- **Skin patterns rendered**: fade / stripes / spots / bands / ink accents drawn
  procedurally per block (mirrors web sprite variants).
- **Golden pellets**: parsed (index 5), drawn ×1.35 amber cube + pulsing halo +
  orbiting glints.
- **Spawn shield**: slot-9 flag parsed (was misread as "boost"!) → pulsing cream
  head shimmer. Spark-trail bug fixed as a side effect.
- **HUD redesign parity**: transparent minimap w/ live arena showing through,
  borderless dark-glass top-3 leaderboard (names only, no RANK header/medals),
  ✕ back-to-lobby button beside it, translucent joystick ring, thumb-sized boost
  button (64dp orange/red), ping pill, champion banner.
- **Personal bests**: SharedPreferences progression (bestLen/mostKills/games) with
  menu strip + death-screen PB banner + "Max Length · PB n" stat.
- **Camera smoothing fix**: camera was snapping to raw row targets every tick
  (the Android "laggy/jittery" feel) — now exponentially follows the smoothed
  self position (or spectate target) with teleport snap at >3000u.

**Build verified**: `gradlew :app:compileDebugKotlin` + `:app:assembleDebug` both
BUILD SUCCESSFUL (requires JDK 21 via `-Dorg.gradle.java.home=<Android Studio jbr>`
on this machine — system default JDK 25 breaks the bundled Kotlin compiler's
version parser). Fresh APK: android/app/build/outputs/apk/debug/app-debug.apk.

## ANDROID AUDIT PASS (post-parity recheck)
- Camera zoom floor aligned to web (0.62, was 0.60) — identical zoom feel.
- Double safe-inset removed from top-right HUD row (root HUD already applies
  safeDrawing insets — content double-offset toward screen center on notches).
- Champion banner dropped below killfeed max height (top 96dp) — no overlap.
- Verified sound: chain sim parity, boost-glow bitmaps (ADD blend), shield
  shimmer paint-state resets, magnetism culling margin, TTL sweep with new
  iteration shape, no stale `.boost` references, prefs positional order.
- Fresh APK rebuilt after fixes: app-debug.apk (Aug 25 21:13).
