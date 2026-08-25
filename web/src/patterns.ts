/**
 * Neo-Brutalism Color Palette & 5-Block Repeating Chain Engine
 */
export const PALETTE: readonly string[] = [
  "#FFD93D", // 0: Punchy Yellow
  "#FF5722", // 1: Fiery Orange
  "#00C2D1", // 2: Electric Cyan
  "#A8E10C", // 3: Bright Lime
  "#FF5CA8", // 4: Bubblegum Pink
  "#7C5CFF", // 5: Electric Violet
  "#00D1C0", // 6: Mint Teal
  "#FF3B30", // 7: Vivid Red
  "#FF9A9E", // 8: Pastel Coral
  "#C0C0FF", // 9: Lavender
  "#FFAA00", // 10: Amber Gold
  "#FFFFFF", // 11: Crisp White
] as const;

export const INK = "#141414";
export const CREAM = "#FFF8E7";

/** How long a death drop glows after spawning. Must match
 *  DEATH_DROP_GLOW_MS in server/src/config.ts (server stamps `isDrop`
 *  with the same window in sync rows, batch events and join snapshots). */
export const DEATH_DROP_GLOW_MS = 4000;

export function baseColor(idx: number): string {
  const i = ((idx % PALETTE.length) + PALETTE.length) % PALETTE.length;
  return PALETTE[i]!;
}

/**
 * Unpacks a packed number into an array of color indices [0..11], length 1..8.
 * Format: Lowest nibble is count (N in 1..8). Next N nibbles are the color indices.
 * Backward compatible with legacy single color or countless 5-color packs.
 *
 * Ambiguity note: canonical chain [0] encodes to integer 1, inside the legacy
 * single range — value 1 is therefore DEFINED as canonical [0] (pure yellow
 * head). Server mirror lives in server/src/colors.ts; keep in sync.
 */
export function unpackColors(packed: number): number[] {
  if (packed === 1) {
    return [0];
  }
  if (packed < 12) {
    return [packed];
  }
  const count = packed % 16;
  if (count >= 1 && count <= 8) {
    const out: number[] = [];
    let rem = Math.floor(packed / 16);
    for (let i = 0; i < count; i++) {
      out.push((rem % 16) % 12);
      rem = Math.floor(rem / 16);
    }
    return out.length > 0 ? out : [0];
  }
  // Legacy 5-color fallback
  const c0 = packed % 16;
  const c1 = Math.floor(packed / 16) % 16;
  const c2 = Math.floor(packed / 256) % 16;
  const c3 = Math.floor(packed / 4096) % 16;
  const c4 = Math.floor(packed / 65536) % 16;
  return [c0 % 12, c1 % 12, c2 % 12, c3 % 12, c4 % 12];
}

/**
 * Packs 1..8 color indices into a single integer.
 */
export function packColors(colors: number[]): number {
  const list = colors.length > 0 ? colors.slice(0, 8) : [0];
  const count = list.length;
  let p = count;
  for (let i = 0; i < count; i++) {
    const c = (((list[i] ?? 0) % 12) + 12) % 12;
    p += c * Math.pow(16, i + 1);
  }
  return p;
}

/** Neo-brutalism shade helper (light bevel or dark hard shadow) */
export function shade(color: string, t: number): string {
  const hex = color.replace("#", "");
  const num = parseInt(hex, 16);
  let r = (num >> 16) & 255;
  let g = (num >> 8) & 255;
  let b = num & 255;
  if (t >= 0) {
    r = Math.min(255, Math.round(r + (255 - r) * t));
    g = Math.min(255, Math.round(g + (255 - g) * t));
    b = Math.min(255, Math.round(b + (255 - b) * t));
  } else {
    const f = 1 + t;
    r = Math.max(0, Math.round(r * f));
    g = Math.max(0, Math.round(g * f));
    b = Math.max(0, Math.round(b * f));
  }
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}
