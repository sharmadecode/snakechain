/**
 * Canonical snake color-chain wire format — the ONLY producer format.
 *
 * Layout (base-16 nibbles, least significant first):
 *   nibble 0      = chain length N (1..8)
 *   nibble 1..N   = palette indices 0..11
 * Values below 12 are the legacy "single color" form; values whose low
 * nibble is not a legal count fall back to reading five raw nibbles
 * (legacy countless packs). This mirrors web/src/patterns.ts
 * packColors/unpackColors exactly — keep the two in sync and prefer
 * changes here being mirrored there (and vice versa).
 */

export const CHAIN_MAX_COLORS = 8;
export const PALETTE_SIZE = 12;

/** Legal maximum packed value: count nibble 8 plus 8 color nibbles of 11. */
export const CHAIN_PACKED_MAX =
  CHAIN_MAX_COLORS + (PALETTE_SIZE - 1) * ((16 ** (CHAIN_MAX_COLORS + 1) - 16) / 15);

function normIdx(v: number): number {
  return ((Math.floor(v) % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
}

/** Pack 1..8 palette indices into the canonical count-nibble format. */
export function packChain(colors: readonly number[]): number {
  const list = colors.length > 0 ? colors.slice(0, CHAIN_MAX_COLORS) : [0];
  let p = list.length;
  for (let i = 0; i < list.length; i++) p += normIdx(list[i] ?? 0) * 16 ** (i + 1);
  return p;
}

/**
 * Unpack a broadcast row's colorIdx into palette indices. Accepts canonical
 * chains, legacy singles (<12) and legacy countless 5-nibble packs.
 *
 * Ambiguity note: canonical chain [0] encodes to the integer 1, which sits
 * inside the legacy-single range. Value 1 is therefore DEFINED as canonical
 * [0] (pure yellow head). Nothing else in the system ever emits a bare 1 as
 * a meaningful legacy single — client packColors produces ≥17 for length-1
 * chains — so the definition is unambiguous in practice.
 */
export function unpackChain(packed: number): number[] {
  if (packed === 1) return [0];
  if (packed < 12) return [packed];
  const count = packed % 16;
  if (count >= 1 && count <= CHAIN_MAX_COLORS) {
    const out: number[] = [];
    let rem = Math.floor(packed / 16);
    for (let i = 0; i < count; i++) {
      out.push((rem % 16) % PALETTE_SIZE);
      rem = Math.floor(rem / 16);
    }
    return out.length > 0 ? out : [0];
  }
  const c = (n: number): number => (Math.floor(packed / 16 ** n) % 16) % PALETTE_SIZE;
  return [c(0), c(1), c(2), c(3), c(4)];
}

/**
 * True when `packed` is a well-formed canonical chain (count nibble 1..8).
 * Used by join validation: anything else that survives the magnitude bound
 * falls back to the neutral default instead of leaking garbage into rows.
 */
export function isCanonicalChain(packed: number): boolean {
  const count = packed % 16;
  return count >= 1 && count <= CHAIN_MAX_COLORS;
}
