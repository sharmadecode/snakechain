export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;

export const BASE_SPEED = 170;
export const BOOST_SPEED = 320;
export const BOOST_DRAIN_PER_SEC = 6; // Gentle, strategic mass drain (reduced from 25 -> 6/sec)
export const BOOST_MIN_LENGTH = 45;
export const BOOST_DROP_INTERVAL_TICKS = 6; // Drop mass pellet every 6 ticks (5 Hz) while boosting

// Circular Arena Radius (Large scalable arena)
export const WORLD_HALF = 3600;

// Arena cap: total actors (humans + bots). Bots fill remaining slots up to
// BOT_MAX and are despawned only when humans push past ACTOR_CAP - BOT_MAX.
export const ACTOR_CAP = 400;
export const BOT_MAX = 20;

// Per-client interest radius bounds. Clients report their real view
// half-diagonal at the renderer zoom floor (0.62 — see web render camera
// clamp): 1080p desktop ≈ 1777 px, 4K ≈ 3553 px, landscape phones ≈ 700–900.
// The floor keeps sparse regions lively on small screens without forcing
// phones to download desktop-sized interest sets; the ceiling caps hostile
// requests. Never trust the client blindly.
export const VIEW_FLOOR = 800;
export const VIEW_MAX = 3600;

// Extra world-units added ON TOP of each client's viewport radius when the
// server decides what to stream (state rows, bodies, food). Guarantees a
// snake that can physically reach you is already in your client's data
// before it is on your screen — kills "invisible killer" classes caused by
// interest-edge flapping or any radius math mismatch between ends.
export const INTEREST_SAFETY = 200;

// Collision grid stride: sample every 1st body segment for pixel-perfect collision
export const BODY_SEGMENT_STRIDE = 1;

// Authoritative body snapshot spacing (world units) and point cap, sent
// head->tail. Not sent at 30 TPS — only on view entry, ~10 TPS while
// visible, and on significant growth.
export const BODY_SAMPLE_DIST = 22;
export const BODY_SAMPLE_CAP = 140;
export const BODY_GROWTH_RESEND = 250;

// Full authoritative food re-sync interval for each client's view (kills
// ghosts from events that were filtered while the client was far away).
export const FOOD_SYNC_MS = 10000;

// Food event `f` messages are batched: the collision grid updates every
// tick, but per-client event messages flush only every FOOD_EVENT_BATCH
// ticks (~5 Hz) so a 192/tick food fill cannot flood every client 30 TPS.
export const FOOD_EVENT_BATCH = 6;

export const START_LENGTH = 35;
// --- follow-the-leader chain physics (see PHASES.md §1) -------------------
// The body is a chain of segments; px[0] IS the head. Each tick every segment
// is pulled onto the ring of radius POINT_SPACING around its predecessor
// whenever it trails farther — loops compact and corners cut like a real snake.
export const MIN_CHAIN_SEGS = 4;
export const CHAIN_GROW_PER_TICK = 3;
// Global growth-rate dial: multiplies every length gain from food (natural
// pellets, boost drops AND death drops). 0.75 = snakes grow 25% slower than
// the raw values minted into drops. Single tuning knob by design.
export const GROWTH_RATE = 0.75;
// Spawn protection: freshly spawned snakes can't be killed for this window.
// Eating or boosting breaks it instantly. Kept SHORT (1.2s) — longer windows
// made freshly-respawned bots unhittable ghosts (“bites don't register”).
export const SPAWN_PROTECT_MS = 1200;
// Golden pellet: rarity among NATURAL food spawns, and its mass value.
export const GOLDEN_CHANCE = 0.01;
export const GOLDEN_VALUE = 10;
// --- Battle-Royale collapse (runs ONLY in “collapse”-mode arenas) ---------
// Main/classic arenas keep the CONSTANT slither-io style map. Collapse rounds:
// wall steps down ×0.82 every 25s, eases at 90 u/s, floor at halfW 650,
// 30s endgame hold, #1 crowned CHAMPION, wall re-expands, next round.
export const BR_SHRINK_INTERVAL_MS = 25_000;
export const BR_SHRINK_FACTOR = 0.82;
export const BR_MIN_HALFW = 650;
export const BR_HOLD_MS = 30_000;
export const BR_FIRST_DELAY_MS = 40_000;
export const BR_WALL_SPEED = 90; // world units/sec of eased wall movement
// ---------------------------------------------------------------------------
// Bots enter the arena at BOT_START_LENGTH points and can NEVER exceed
// BOT_MAX_POINTS (enforced in Player.eat). Death drops mint from targetLen,
// so capping bots also caps corpse windfalls — surplus mass a capped bot eats
// stays in the world as claimable loot for humans.
export const BOT_START_LENGTH = 100;
export const BOT_MAX_POINTS = 500;
// Body-point array cap. Now the CHAIN SEGMENT cap: MAX_POINTS × POINT_SPACING
// is the maximum possible snake length, and the adaptive bodyRow() streamer
// covers every segment within BODY_SAMPLE_CAP samples — no body section can
// ever be unseen-but-lethal.
export const MAX_POINTS = 800;
export const LENGTH_PER_FOOD = 1;
export const PASSIVE_GROW_PER_SEC = 0;
// remove the old duplicate MAX_POINTS line further down

export const POINT_SPACING = 10;
export const THICK_MIN = 18;
export const THICK_MAX = 52;
// Thickness curve: maxes out at 800 length-units — early chunkiness by
// design (giants differentiate via length, not endless width).
export const THICK_GROW_AT = 800;

// Agility / Turning: small snakes turn sharply, giant snakes turn wider
export const MIN_TURN_SPEED = 2.8; // rad/s for huge snakes
export const MAX_TURN_SPEED = 6.0; // rad/s for small agile snakes
export const TURN_SPEED_FALLOFF = 800; // length scale for turn speed falloff

export const FOOD_PER_ACTOR = 180;
export const FOOD_CAP = 4800;
export const FOOD_EAT_MARGIN = 18;
export const FOOD_SPAWN_PER_TICK = 32;
export const FOOD_MAX_SPAWN_TRIES = 5;

// Fresh death drops are invisible to bot grazing for this long, so the
// killer (or any nearby human) can claim them before the bot swarm does.
export const FOOD_DROP_BOT_IGNORE_MS = 3500;

// How long a death drop glows on clients (sync rows, batch events and the
// join snapshot all stamp `isDrop` with the same window). Keep in sync with
// DEATH_DROP_GLOW_MS in web/src/patterns.ts.
export const DEATH_DROP_GLOW_MS = 4000;

export const BOT_EYES = 360;
export const BOT_RESPAWN_MIN_MS = 3500;
export const BOT_RESPAWN_MAX_MS = 7000;

export const NUM_COLORS = 12;
export const NUM_PATTERNS = 6;

export const MAX_NAME_LEN = 14;
export const INPUT_RATE_PER_SEC = 60;
export const MAX_MSG_BYTES = 1024;
export const MAX_CONNS_PER_IP = 8;
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const WS_MAX_BUFFERED = 1_000_000;

export const LEADERBOARD_SIZE = 3;
export const LEADERBOARD_INTERVAL_MS = 1000;

export const BOT_NAMES = [
  "Viper", "Cobra", "Python", "Mamba", "Hydra", "Kaa", "Basilisk", "Naga", "Serpent", "Slinky",
  "Titan", "Apex", "Nova", "Shadow", "Ghost", "Blaze", "Frost", "Venom", "Volt", "Fang",
  "Echo", "Draco", "Ziggy", "Neon", "Rogue", "Spike", "Kraken", "Onyx", "Pulse", "Raptor",
  "Cipher", "Zenith", "Turbo", "Vortex", "Comet", "Solar", "Storm", "Abyss", "Talon", "Zero",
];

export const COLORS: readonly string[] = [
  "#FF3366", "#FF7700", "#FFD700", "#00E676",
  "#00D2FF", "#7C4DFF", "#FF4081", "#00F5D4",
  "#FF9100", "#AEEA00", "#E040FB", "#FFAB00",
];

