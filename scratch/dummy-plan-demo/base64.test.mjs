import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from './base64.mjs';

// RFC 4648 §10 test vectors.
const VECTORS = [
  ['', ''],
  ['f', 'Zg=='],
  ['fo', 'Zm8='],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg=='],
  ['fooba', 'Zm9vYmE='],
  ['foobar', 'Zm9vYmFy'],
];

test('encode produces the RFC 4648 known vectors', () => {
  for (const [plain, b64] of VECTORS) {
    assert.equal(encode(plain), b64, `encode(${JSON.stringify(plain)})`);
  }
});

test('decode inverts each known vector', () => {
  for (const [plain, b64] of VECTORS) {
    assert.equal(decode(b64), plain, `decode(${JSON.stringify(b64)})`);
  }
});

test('round-trips multibyte UTF-8', () => {
  const inputs = [
    'héllo',
    '😀',
    'Grüße aus Köln 🇩🇪',
    '日本語のテキスト',
    'mixed: ASCII + héllo + 😀😀 + 日本語 '.repeat(50),
  ];
  for (const s of inputs) {
    assert.equal(decode(encode(s)), s, `round-trip ${JSON.stringify(s.slice(0, 20))}`);
  }
});

test('round-trips every byte-length remainder (padding shapes)', () => {
  // exercises 0/1/2 trailing bytes -> '', '=', '==' padding shapes
  let s = '';
  for (let i = 0; i < 64; i++) {
    assert.equal(decode(encode(s)), s, `len ${i}`);
    s += String.fromCharCode(33 + (i % 90)); // printable ASCII
  }
});

test('decode throws RangeError on out-of-alphabet characters', () => {
  assert.throws(() => decode('!!!!'), RangeError);
  assert.throws(() => decode('Zm9 v'), RangeError); // space is not in the alphabet
  assert.throws(() => decode('Zm9*'), RangeError);
});

test('decode throws RangeError on bad length (not a multiple of 4)', () => {
  assert.throws(() => decode('Zg='), RangeError);
  assert.throws(() => decode('Zg'), RangeError);
  assert.throws(() => decode('Zm9vY'), RangeError);
});

test('decode throws RangeError on misplaced or excess padding', () => {
  assert.throws(() => decode('Zg==='), RangeError); // length 5, not a multiple of 4
  assert.throws(() => decode('Zm9v===='), RangeError); // a whole group of padding
  assert.throws(() => decode('=Zm9'), RangeError); // leading padding
  assert.throws(() => decode('Z=g='), RangeError); // interior padding
  assert.throws(() => decode('Zg==Zg=='), RangeError); // padding mid-string
});
