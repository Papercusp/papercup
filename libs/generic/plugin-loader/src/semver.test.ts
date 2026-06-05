import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { satisfies } from './semver';

describe('semver.satisfies', () => {
  it('exact X.Y.Z matches only that version', () => {
    assert.equal(satisfies('1.2.3', '1.2.3'), true);
    assert.equal(satisfies('1.2.4', '1.2.3'), false);
    assert.equal(satisfies('1.2.2', '1.2.3'), false);
  });

  it('* matches anything', () => {
    assert.equal(satisfies('0.0.1', '*'), true);
    assert.equal(satisfies('99.99.99', '*'), true);
  });

  it('^1.2.3 covers 1.2.3 .. <2.0.0', () => {
    assert.equal(satisfies('1.2.3', '^1.2.3'), true);
    assert.equal(satisfies('1.5.0', '^1.2.3'), true);
    assert.equal(satisfies('1.2.2', '^1.2.3'), false);
    assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  });

  it('^0.1.0 locks on minor (caret-leading-zero)', () => {
    assert.equal(satisfies('0.1.0', '^0.1.0'), true);
    assert.equal(satisfies('0.1.5', '^0.1.0'), true);
    assert.equal(satisfies('0.2.0', '^0.1.0'), false);
    assert.equal(satisfies('0.0.9', '^0.1.0'), false);
  });

  it('^0.0.3 locks on patch', () => {
    assert.equal(satisfies('0.0.3', '^0.0.3'), true);
    assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  });

  it('~1.2.3 covers 1.2.3 .. <1.3.0', () => {
    assert.equal(satisfies('1.2.3', '~1.2.3'), true);
    assert.equal(satisfies('1.2.99', '~1.2.3'), true);
    assert.equal(satisfies('1.3.0', '~1.2.3'), false);
  });

  it('>=1.2.3 covers 1.2.3 and above', () => {
    assert.equal(satisfies('1.2.3', '>=1.2.3'), true);
    assert.equal(satisfies('99.0.0', '>=1.2.3'), true);
    assert.equal(satisfies('1.2.2', '>=1.2.3'), false);
  });

  it('shorthand X.Y / X parse as X.Y.0 / X.0.0', () => {
    assert.equal(satisfies('1.2.0', '^1.2'), true);   // ^1.2 → ^1.2.0 → [1.2.0, 2.0.0)
    assert.equal(satisfies('1.5.9', '^1.2'), true);
    assert.equal(satisfies('0.1.5', '^0.1'), true);   // caret-leading-zero
    assert.equal(satisfies('0.2.0', '^0.1'), false);
    assert.equal(satisfies('2.5.0', '^2'), true);     // ^2 → ^2.0.0 → [2.0.0, 3.0.0)
  });

  it('malformed range fails closed', () => {
    assert.equal(satisfies('1.2.3', 'banana'), false);
    assert.equal(satisfies('1.2.3', ''), false);
    assert.equal(satisfies('1.2.3', '^a.b.c'), false);
  });

  it('malformed version fails closed', () => {
    assert.equal(satisfies('not-a-version', '^1.0.0'), false);
  });
});
