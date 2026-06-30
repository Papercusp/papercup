import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gcd, lcm } from './gcdlcm.mjs';

test('gcd(12, 18) = 6', () => {
  assert.equal(gcd(12, 18), 6);
});

test('gcd(0, 5) = 5', () => {
  assert.equal(gcd(0, 5), 5);
});

test('gcd(-12, 18) = 6', () => {
  assert.equal(gcd(-12, 18), 6);
});

test('lcm(4, 6) = 12', () => {
  assert.equal(lcm(4, 6), 12);
});

test('lcm(0, 5) = 0', () => {
  assert.equal(lcm(0, 5), 0);
});

test('lcm(7, 5) = 35', () => {
  assert.equal(lcm(7, 5), 35);
});
