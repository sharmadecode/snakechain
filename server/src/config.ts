export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;

export const BASE_SPEED = 170;
export const BOOST_SPEED = 320;
export const BOOST_DRAIN_PER_SEC = 6; // Gentle, strategic mass drain (reduced from 25 -> 6/sec)
export const BOOST_MIN_LENGTH = 45;
export const BOOST_DROP_INTERVAL_TICKS = 6; // Drop mass pellet every 6 ticks (5 Hz) while boosting

// Circular Arena Radius (Large scalable arena)
export const ARENA_RADIUS = 3600;
export const WORLD_HALF = 3600;

// Arena cap: total actors (humans + bots) never exceeds ACTOR_CAP; bots
// fill the remaining slots up to BOT_MAX. 0 humans -> 12 bots, 50 humans
// -> 0 bots. Keeps the empty-server case lively without a CPU farm.
export const ACTOR_CAP = 400;
export const BOT_MAX = 20;

// Per-client visibility radius for interest management: must exceed the
// client's max view half-diagonal (renderer zooms out to 0.64 for huge
// snakes → ~1802px on 1080p) so nothing pops in at the screen edge.
export const VIEW_HALF = 1900;
// Hard cap on a client-reported viewport radius (4K fullscreen at zoom
// floor 0.64 ≈ 3440). Never trust the client blindly.
export const VIEW_MAX = 3600;

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
export const LENGTH_PER_FOOD = 1;
export const PASSIVE_GROW_PER_SEC = 0;
export const MAX_POINTS = 3000;

export const POINT_SPACING = 10;
export const THICK_MIN = 18;
export const THICK_MAX = 52;
export const THICK_GROW_AT = 1600;

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

