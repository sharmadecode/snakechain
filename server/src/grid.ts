const SHIFT = 4096;
const MUL = 16384;

/**
 * Spatial hash grid with differential updates. Food is inserted/removed at
 * spawn/eat time (it never moves); body segments are replaced per player
 * every tick via segmentCells + insertInto/removeFrom using cell lists
 * recorded on the entry, so nothing is ever rebuilt from scratch. Cell
 * index math via key() stays collision-free while |cell coord| < SHIFT
 * (=4096); the arena (±3600 world units / 48-unit cells ≈ ±75 cells) fits
 * with a huge margin.
 */
export class Grid<T> {
  readonly cell: number;
  private map = new Map<number, T[]>();

  constructor(cell: number) {
    this.cell = cell;
  }

  private key(cx: number, cy: number): number {
    return (cx + SHIFT) * MUL + (cy + SHIFT);
  }

  /** Insert a stationary item at (x, y). */
  insert(x: number, y: number, item: T): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const arr = this.map.get(k);
    if (arr) arr.push(item);
    else this.map.set(k, [item]);
  }

  remove(x: number, y: number, item: T): void {
    const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const arr = this.map.get(k);
    if (arr) {
      const i = arr.indexOf(item);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) this.map.delete(k);
    }
  }

  segmentCells(ax: number, ay: number, bx: number, by: number): number[] {
    const c = this.cell;
    const x0 = Math.floor(Math.min(ax, bx) / c);
    const x1 = Math.floor(Math.max(ax, bx) / c);
    const y0 = Math.floor(Math.min(ay, by) / c);
    const y1 = Math.floor(Math.max(ay, by) / c);
    const keys: number[] = [];
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) keys.push(this.key(cx, cy));
    }
    return keys;
  }

  insertInto(keys: number[], item: T): void {
    for (const k of keys) {
      const arr = this.map.get(k);
      if (arr) arr.push(item);
      else this.map.set(k, [item]);
    }
  }

  removeFrom(keys: number[], item: T): void {
    for (const k of keys) {
      const arr = this.map.get(k);
      if (arr) {
        const i = arr.indexOf(item);
        if (i >= 0) arr.splice(i, 1);
        if (arr.length === 0) this.map.delete(k);
      }
    }
  }

  /** Run cb for every item in cells overlapping the circle (x,y,r). */
  forEachNear(x: number, y: number, r: number, cb: (item: T) => void): void {
    const c = this.cell;
    const x0 = Math.floor((x - r) / c);
    const x1 = Math.floor((x + r) / c);
    const y0 = Math.floor((y - r) / c);
    const y1 = Math.floor((y + r) / c);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const arr = this.map.get(this.key(cx, cy));
        if (arr) for (let i = 0; i < arr.length; i++) cb(arr[i]!);
      }
    }
  }
}
