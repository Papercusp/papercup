import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRoman, fromRoman } from './roman.mjs';

const CASES = [
  [1, 'I'],
  [4, 'IV'],
  [9, 'IX'],
  [40, 'XL'],
  [90, 'XC'],
  [400, 'CD'],
  [900, 'CM'],
  [2024, 'MMXXIV'],
  [3999, 'MMMCMXCIX'],
];

test('toRoman produces canonical subtractive numerals', () => {
  for (const [n, s] of CASES) assert.equal(toRoman(n), s);
});

test('fromRoman round-trips toRoman', () => {
  for (const [n, s] of CASES) assert.equal(fromRoman(s), n);
});

test('fromRoman is case-insensitive', () => {
  assert.equal(fromRoman('xiv'), 14);
});

test('toRoman rejects out-of-range values', () => {
  assert.throws(() => toRoman(0), RangeError);
  assert.throws(() => toRoman(4000), RangeError);
  assert.throws(() => toRoman(3.5), RangeError);
});

test('fromRoman rejects non-canonical input', () => {
  assert.throws(() => fromRoman('IIII'));
  assert.throws(() => fromRoman('ZZ'));
});
