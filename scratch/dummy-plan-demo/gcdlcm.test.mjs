import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gcd, lcm } from './gcdlcm.mjs';

describe('gcd', () => {
  it('gcd(12, 18) === 6', () => assert.equal(gcd(12, 18), 6));
  it('gcd(0, 5) === 5', () => assert.equal(gcd(0, 5), 5));
  it('gcd(-12, 18) === 6', () => assert.equal(gcd(-12, 18), 6));
});

describe('lcm', () => {
  it('lcm(4, 6) === 12', () => assert.equal(lcm(4, 6), 12));
  it('lcm(0, 5) === 0', () => assert.equal(lcm(0, 5), 0));
  it('lcm(7, 5) === 35', () => assert.equal(lcm(7, 5), 35));
});
