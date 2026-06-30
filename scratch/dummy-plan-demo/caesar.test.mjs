// caesar.test.mjs — node:test suite for caesar.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from './caesar.mjs';

describe('encode — basic shift', () => {
  it('shifts lowercase letters', () => {
    assert.equal(encode('abc', 1), 'bcd');
    assert.equal(encode('hello', 3), 'khoor');
  });

  it('shifts uppercase letters', () => {
    assert.equal(encode('ABC', 1), 'BCD');
    assert.equal(encode('HELLO', 3), 'KHOOR');
  });
});

describe('encode — alphabet wraparound', () => {
  it('wraps z → a (lowercase)', () => {
    assert.equal(encode('z', 1), 'a');
    assert.equal(encode('xyz', 3), 'abc');
  });

  it('wraps Z → A (uppercase)', () => {
    assert.equal(encode('Z', 1), 'A');
    assert.equal(encode('XYZ', 3), 'ABC');
  });
});

describe('encode — case preservation', () => {
  it('preserves mixed case', () => {
    assert.equal(encode('Hello', 1), 'Ifmmp');
    assert.equal(encode('World', 13), 'Jbeyq');
  });
});

describe('encode — non-letter passthrough', () => {
  it('passes digits through', () => {
    assert.equal(encode('abc123', 1), 'bcd123');
  });

  it('passes punctuation and spaces through', () => {
    assert.equal(encode('Hello, World!', 0), 'Hello, World!');
    assert.equal(encode('a b!', 1), 'b c!');
  });
});

describe('encode — negative shift', () => {
  it('shift -1 moves letters backward', () => {
    assert.equal(encode('bcd', -1), 'abc');
  });

  it('shift -1 wraps a → z', () => {
    assert.equal(encode('abc', -1), 'zab');
  });
});

describe('encode — large shift normalization', () => {
  it('shift 27 behaves like shift 1', () => {
    assert.equal(encode('abc', 27), encode('abc', 1));
  });

  it('shift 52 behaves like shift 0 (identity)', () => {
    assert.equal(encode('abc', 52), 'abc');
  });

  it('shift -27 behaves like shift -1', () => {
    assert.equal(encode('abc', -27), encode('abc', -1));
  });

  it('shift 1000 is normalized mod 26', () => {
    assert.equal(encode('abc', 1000), encode('abc', 1000 % 26));
  });
});

describe('decode∘encode round-trip', () => {
  const text = 'Hello, World! 123';

  for (const shift of [1, 13, 25, -1, -13, 100, -100]) {
    it(`round-trip with shift=${shift}`, () => {
      assert.equal(decode(encode(text, shift), shift), text);
    });
  }
});

describe('decode — basic', () => {
  it('reverses encode', () => {
    assert.equal(decode('bcd', 1), 'abc');
    assert.equal(decode('khoor', 3), 'hello');
  });
});

describe('validation — throws on non-integer shift', () => {
  it('throws TypeError for float', () => {
    assert.throws(() => encode('abc', 1.5), TypeError);
  });

  it('throws TypeError for string', () => {
    assert.throws(() => encode('abc', 'a'), TypeError);
  });

  it('throws TypeError for NaN', () => {
    assert.throws(() => encode('abc', NaN), TypeError);
  });

  it('throws TypeError in decode too', () => {
    assert.throws(() => decode('abc', 1.5), TypeError);
  });
});
