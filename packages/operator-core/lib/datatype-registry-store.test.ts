/**
 * datatype-registry-store.test.ts — the PG-free, pure helpers of the datatype
 * registry store (P-013). The CRUD itself is integration-covered against PG; here
 * we pin the slug derivation + tier guard exhaustively (no PG / embedder), mirroring
 * the recipes-store test philosophy.
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { slugifyDatatype, isDatatypeTier, DATATYPE_TIERS } from './datatype-registry-store';

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
