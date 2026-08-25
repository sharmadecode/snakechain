/**
 * Unit tests for the canonical color-chain codec (server/src/colors.ts).
 *
 * GL-01 regression: bots previously packed five raw nibbles with no count
 *   nibble; the client read nibble 0 as the chain length, corrupting most
 *   bot skins.
 * GL-02 regression: join validation previously applied `% 2^20`, truncating
 *   legal 5–8 color chains (the fifth block silently became palette 0).
 *
 * Run: npm run test:unit   (pure functions — no sockets, no server needed)
 */
import assert from "node:assert/strict";
import {
  packChain, unpackChain, isCanonicalChain, CHAIN_PACKED_MAX,
} from "../src/colors.js";

let passed = 0;
let failed = 0;
const fails: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed++;
    fails.push(`${name}: ${(err as Error).message}`);
    console.log(`FAIL  ${name}: ${(err as Error).message}`);
  }
}

// ---- Canonical round-trips -------------------------------------------------
check("packChain([0]) -> unpack identity", () => {
  assert.deepEqual(unpackChain(packChain([0])), [0]);
});
check("packChain([7]) -> unpack identity", () => {
  assert.deepEqual(unpackChain(packChain([7])), [7]);
});
check("packChain([0,1,4,2,3]) -> unpack identity", () => {
  assert.deepEqual(unpackChain(packChain([0, 1, 4, 2, 3])), [0, 1, 4, 2, 3]);
});
check("packChain 8-chain round-trip", () => {
  const chain = [11, 10, 9, 8, 7, 6, 5, 4];
  assert.deepEqual(unpackChain(packChain(chain)), chain);
});
check("packChain normalizes out-of-range indices mod 12", () => {
  assert.deepEqual(unpackChain(packChain([12])), [0]);
  assert.deepEqual(unpackChain(packChain([13])), [1]);
});
check("ALL singleton chains round-trip exactly (incl. the value-1 ambiguity)", () => {
  for (let i = 0; i < 12; i++) {
    assert.deepEqual(unpackChain(packChain([i])), [i], `singleton [${i}]`);
  }
});
check("value 1 is DEFINED as canonical [0] (yellow head), not legacy orange", () => {
  assert.deepEqual(unpackChain(1), [0]);
});
check("GL-01 bot vector [3,5,7,9,11] survives a full round-trip", () => {
  // Under the old countless packing this rendered as [5,7] + garbage.
  assert.deepEqual(unpackChain(packChain([3, 5, 7, 9, 11])), [3, 5, 7, 9, 11]);
});

// ---- Wire-format compatibility --------------------------------------------
check("client packColors value for default chain is preserved by unpack", () => {
  // web packColors([0,1,4,2,3]) === 3293445 (count nibble 5 + color nibbles)
  assert.equal(packChain([0, 1, 4, 2, 3]), 3293445);
});
check("legacy single-color values still unpack to themselves (except 1 = canonical [0])", () => {
  for (let i = 0; i < 12; i++) {
    if (i === 1) continue; // redefined: see "value 1 is DEFINED as canonical [0]"
    assert.deepEqual(unpackChain(i), [i]);
  }
});
check("isCanonicalChain accepts counts 1..8 and rejects others", () => {
  assert.equal(isCanonicalChain(packChain([1])), true);
  assert.equal(isCanonicalChain(packChain([0, 1, 2, 3, 4, 5, 6, 7])), true);
  assert.equal(isCanonicalChain(15), false);          // low nibble 15: not a count
  assert.equal(isCanonicalChain(16 * 12), false);     // count nibble 0
});
check("CHAIN_PACKED_MAX bounds the domain and itself round-trips", () => {
  const max = packChain([11, 11, 11, 11, 11, 11, 11, 11]);
  assert.ok(max <= CHAIN_PACKED_MAX);
  assert.deepEqual(unpackChain(max), [11, 11, 11, 11, 11, 11, 11, 11]);
});
check("GL-02 regression: old truncated wire value now decodes correctly", () => {
  // Old path: 3293445 % 2^20 === 147717 → decoded to [0,1,4,2,0].
  // New path: the full value passes validation untouched.
  assert.notEqual(3293445 % (2 ** 20), 3293445);       // the bug existed
  assert.deepEqual(unpackChain(3293445), [0, 1, 4, 2, 3]); // and is gone
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
