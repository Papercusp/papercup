/**
 * datatype-registry-store.test.ts — the PG-free, pure helpers of the datatype
 * registry store (P-013). The CRUD itself is integration-covered against PG; here
 * we pin the slug derivation + tier guard exhaustively (no PG / embedder), mirroring
 * the recipes-store test philosophy.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  slugifyDatatype,
  isDatatypeTier,
  DATATYPE_TIERS,
  canonicalDatatypeKey,
} from './datatype-registry-store';

test('slugifyDatatype — lowercases, collapses non-alphanumerics to single dashes, trims', () => {
  assert.equal(slugifyDatatype('bet'), 'bet');
  assert.equal(slugifyDatatype('Bet Thesis'), 'bet-thesis');
  assert.equal(slugifyDatatype('  P&L  '), 'p-l');
  assert.equal(slugifyDatatype('calibration_record'), 'calibration-record');
  assert.equal(slugifyDatatype('Forecast (v2)'), 'forecast-v2');
  assert.equal(slugifyDatatype('---wager---'), 'wager');
  assert.equal(slugifyDatatype('Order #1 // fill'), 'order-1-fill');
});

test('isDatatypeTier — accepts the three tiers, rejects anything else', () => {
  assert.equal(isDatatypeTier('generic-kind'), true);
  assert.equal(isDatatypeTier('first-class'), true);
  assert.equal(isDatatypeTier('projection'), true);
  assert.equal(isDatatypeTier('bogus'), false);
  assert.equal(isDatatypeTier(''), false);
  assert.equal(isDatatypeTier('Generic-Kind'), false); // case-sensitive
});

test('DATATYPE_TIERS is the canonical three-tier set (D-002 + D-008 projection)', () => {
  assert.deepEqual([...DATATYPE_TIERS], ['generic-kind', 'first-class', 'projection']);
});

// ---------------------------------------------------------------------------
// EI-10562 — canonicalDatatypeKey is the THRESHOLD-FREE half of the dedup gate.
// The refusal path must be decidable with CERTAINTY, so it is an exact test on this
// key, never a similarity score. (The score it replaced refused 7 of 7 legitimate
// declarations at `>= 0.05` — cosine >= 0.083, the noise floor — and caught nothing.)
// ---------------------------------------------------------------------------

test('canonicalDatatypeKey — a word and its plural COLLIDE (the duplicate that actually happens)', () => {
  // The whole point: `orders` declared when `order` exists is an unmistakable duplicate.
  assert.equal(canonicalDatatypeKey('orders'), canonicalDatatypeKey('order'));
  assert.equal(canonicalDatatypeKey('fills'), canonicalDatatypeKey('fill'));
  assert.equal(canonicalDatatypeKey('Cash Balances'), canonicalDatatypeKey('cash-balance'));
  assert.equal(canonicalDatatypeKey('boxes'), canonicalDatatypeKey('box'));
  assert.equal(canonicalDatatypeKey('policies'), canonicalDatatypeKey('policy'));
  assert.equal(canonicalDatatypeKey('calibration_records'), canonicalDatatypeKey('Calibration Record'));
});

test('canonicalDatatypeKey — genuinely DISTINCT datatypes never collide, however similar they read', () => {
  // These are the live registry's real neighbours. `bet`/`wager` are near-synonyms that
  // score cosine 0.752 — the HIGHEST pair in the registry — and are nonetheless two
  // legitimately distinct registered kinds. No score can be trusted to tell them apart
  // from a true duplicate (bet/forecast, DISTINCT, scores 0.710). The key can.
  assert.notEqual(canonicalDatatypeKey('bet'), canonicalDatatypeKey('wager'));
  assert.notEqual(canonicalDatatypeKey('bet'), canonicalDatatypeKey('forecast'));
  assert.notEqual(canonicalDatatypeKey('fill'), canonicalDatatypeKey('order'));
  assert.notEqual(canonicalDatatypeKey('position'), canonicalDatatypeKey('cash-balance'));
  assert.notEqual(canonicalDatatypeKey('calibration-record'), canonicalDatatypeKey('forecast'));
});

test('canonicalDatatypeKey — the CONTRACT is collision, not spelling (assert the property, not the key)', () => {
  // The key is deliberately crude — 'status' → 'statu', 'bias' → 'bia'. That is fine and
  // is NOT what this guards: the only property the gate rests on is that a word and its
  // plural land on the SAME key. Pinning the key STRING would pin the implementation; the
  // contract is the collision. Being wrong about English is harmless if it is wrong
  // CONSISTENTLY on both sides.
  for (const [singular, plural] of [
    ['status', 'statuses'],
    ['bias', 'biases'],
    ['loss', 'losses'],
    ['match', 'matches'],
    ['entry', 'entries'],
  ] as const) {
    assert.equal(
      canonicalDatatypeKey(singular),
      canonicalDatatypeKey(plural),
      `${singular} / ${plural} must canonicalize together`,
    );
  }
  assert.equal(canonicalDatatypeKey('gas'), 'gas'); // len 3 → never stripped to nonsense
  assert.equal(canonicalDatatypeKey('loss'), 'loss'); // -ss → never eaten
});

test('canonicalDatatypeKey — KNOWN MISS, documented: irregular plurals do NOT collide, and that is the SAFE direction', () => {
  // 'thesis' → 'thesi' but 'theses' → 'thes'. A miss: the pair is a real plural and the
  // key does not catch it. Recorded deliberately rather than hidden, because the direction
  // matters — a miss ALLOWS the declaration (and the advisory `related[]` still surfaces the
  // neighbour). A refusal gate must fail toward allowing; the bug this replaces failed the
  // other way and refused everything. False negatives cost a nudge; false positives cost the
  // gate itself.
  assert.notEqual(canonicalDatatypeKey('bet-thesis'), canonicalDatatypeKey('bet-theses'));
});

test('canonicalDatatypeKey — IDEMPOTENT: canonical(canonical(x)) === canonical(x)', () => {
  // The invariant the gate rests on. Without it, a singular that merely ENDS in 's'
  // ('status') takes the bare-s rule while its plural takes the '-es' rule, they land on
  // different keys, and the duplicate walks through. Caught by the test above before it
  // shipped — which is the whole argument for writing the guard instead of the comment.
  for (const name of [
    'order', 'orders', 'status', 'statuses', 'bias', 'biases', 'loss', 'losses',
    'bet', 'wager', 'forecast', 'cash-balance', 'cash-balances', 'calibration-record',
    'gas', 'box', 'boxes', 'entry', 'entries', 'Bet Thesis', 'Order #1 // fill',
  ]) {
    const once = canonicalDatatypeKey(name);
    assert.equal(canonicalDatatypeKey(once), once, `not idempotent for "${name}"`);
  }
});

test('canonicalDatatypeKey — total: empty / punctuation-only / mixed input never throws', () => {
  assert.equal(canonicalDatatypeKey(''), '');
  assert.equal(canonicalDatatypeKey('---'), '');
  assert.equal(canonicalDatatypeKey('Order #1 // fill'), 'order-1-fill');
});
