import { GOLDEN_CHANCE, GOLDEN_VALUE, NUM_COLORS } from "./config.js";

export class FoodItem {
  readonly id: number;
  colorIdx: number;
  x: number;
  y: number;
  /** Epoch ms when this item was dropped (0 = natural world fill). */
  dropAt = 0;
  /** Mass growth value when eaten. */
  value = 1;
  /** Golden pellet: rare high-value natural food (drawn with sparkle). */
  isGolden = false;
  /** True ONLY for death drops from eliminated snakes (these glow for 4s). */
  isDeathDrop = false;

  constructor(id: number, x: number, y: number, colorIdx: number, value = 1, isDeathDrop = false) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.colorIdx = colorIdx;
    this.value = value;
    this.isDeathDrop = isDeathDrop;
  }
}

let nextFoodId = 1;

/** Pool of food + the set of ids that were spawned/removed this tick (for client sync). */
export class FoodManager {
  items = new Map<number, FoodItem>();

  /** ids removed this tick (spawned items are tracked as objects only —
      the session needs `sItems` for grid sync + interest filtering, and
      nothing ever consumed the id list). */
  removed: number[] = [];
  /** item refs parallel to removed (for grid sync + interest filtering) */
  spawnedItems: FoodItem[] = [];
  removedItems: FoodItem[] = [];

  private spawnQueued = 0;

  /** NATURAL world-fill pellet; rare golden variant worth GOLDEN_VALUE.
      (Boost drops and death drops use their own methods, never golden.) */
  add(x: number, y: number, colorIdx = Math.floor(Math.random() * NUM_COLORS)): FoodItem {
    const id = nextFoodId++;
    if (nextFoodId > 2 ** 31) nextFoodId = 1;
    const f = new FoodItem(id, x, y, colorIdx, 1, false);
    if (Math.random() < GOLDEN_CHANCE) {
      f.isGolden = true;
      f.value = GOLDEN_VALUE;
      f.colorIdx = 10; // amber gold — matches the dedicated sparkle look
    }
    this.items.set(id, f);
    this.spawnedItems.push(f);
    return f;
  }

  /** Boost drop: mass ejected by boosting snake. Does NOT glow! */
  addBoostDrop(x: number, y: number, colorIdx: number): FoodItem {
    const id = nextFoodId++;
    if (nextFoodId > 2 ** 31) nextFoodId = 1;
    const f = new FoodItem(id, x, y, colorIdx, 1, false);
    f.dropAt = Date.now();
    this.items.set(id, f);
    this.spawnedItems.push(f);
    return f;
  }

  /** Death drop: exact mass-value glowing loot from eliminated snakes. */
  addDeathDrop(x: number, y: number, colorIdx: number, value = 5): FoodItem {
    const id = nextFoodId++;
    if (nextFoodId > 2 ** 31) nextFoodId = 1;
    const f = new FoodItem(id, x, y, colorIdx, value, true);
    f.dropAt = Date.now();
    this.items.set(id, f);
    this.spawnedItems.push(f);
    return f;
  }

  remove(id: number): void {
    const f = this.items.get(id);
    if (f) {
      this.items.delete(id);
      this.removed.push(id);
      this.removedItems.push(f);
    }
  }

  /** Add work to the spawn bucket (async fill done by session). */
  queueSpawn(n: number): void {
    this.spawnQueued += n;
  }

  takeQueued(): number {
    const n = this.spawnQueued;
    this.spawnQueued = 0;
    return n;
  }

  flushEvents(): { r: number[]; sItems: FoodItem[]; rItems: FoodItem[] } {
    const r = this.removed;
    const sItems = this.spawnedItems;
    const rItems = this.removedItems;
    this.removed = [];
    this.spawnedItems = [];
    this.removedItems = [];
    return { r, sItems, rItems };
  }
}
