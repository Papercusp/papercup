import { describe, it } from 'vitest';
import * as assert from 'node:assert/strict';
import { satisfies } from './semver';

// Coverage gap: semver.test.ts covers the main operators but misses several
// untested branches/edges in satisfies() — the `'x'` wildcard token (only `*`
// is tested), the ^0.0.0 / >= / ~ shorthand boundaries, whitespace trimming,
// and the `~<major>` shorthand which DIVERGES from npm. These pin the matcher's
// real contract so a future "let's match npm exactly" change is a deliberate one.

describe('semver.satisfies — untested branches + edges', () => {
  it("the bare 'x' token matches anything (distinct from '*')", () => {
    // satisfies() treats `trimmed === 'x'` as a wildcard — never exercised before.
    assert.equal(satisfies('0.0.1', 'x'), true);
    assert.equal(satisfies('99.99.99', 'x'), true);
    assert.equal(satisfies('not-a-version', 'x'), true); // wildcard short-circuits before parse
  });

  it('^0.0.0 matches ONLY 0.0.0 (caret on all-zero locks the patch)', () => {
    // base {0,0,0} → hi {0,0,1}; the half-open [0.0.0, 0.0.1) is a single point.
    assert.equal(satisfies('0.0.0', '^0.0.0'), true);
    assert.equal(satisfies('0.0.1', '^0.0.0'), false);
  });

  it('~X.Y shorthand locks the minor: ~1.2 → [1.2.0, 1.3.0)', () => {
    assert.equal(satisfies('1.2.0', '~1.2'), true);
    assert.equal(satisfies('1.2.99', '~1.2'), true);
    assert.equal(satisfies('1.3.0', '~1.2'), false);
    assert.equal(satisfies('1.1.9', '~1.2'), false);
  });

  it('~<major> shorthand is [major.0.0, major.1.0) — DIVERGES from npm (npm: <major+1.0.0)', () => {
    // This matcher locks the minor at the parsed (0) minor, so ~1 == [1.0.0, 1.1.0).
    // npm treats ~1 as [1.0.0, 2.0.0). Pinned deliberately: plugin manifests ship
    // full X.Y.Z, so the major-only tilde is out of the supported subset.
    assert.equal(satisfies('1.0.0', '~1'), true);
    assert.equal(satisfies('1.0.99', '~1'), true);
    assert.equal(satisfies('1.1.0', '~1'), false); // npm would say true
  });

  it('>= accepts the X.Y shorthand and internal whitespace', () => {
    assert.equal(satisfies('1.2.0', '>=1.2'), true); // >=1.2 → >=1.2.0
    assert.equal(satisfies('1.1.9', '>=1.2'), false);
    assert.equal(satisfies('50.0.0', '>=1.2'), true);
    assert.equal(satisfies('1.2.3', '>= 1.2.3'), true); // space after >= is trimmed
  });

  it('>= with an unparseable bound fails closed', () => {
    assert.equal(satisfies('9.9.9', '>=banana'), false);
    assert.equal(satisfies('9.9.9', '>='), false); // empty bound after the operator
  });

  it('surrounding whitespace is trimmed on both the range and the version', () => {
    assert.equal(satisfies('1.2.3', '  ^1.2.3  '), true);
    assert.equal(satisfies('  1.2.3  ', '1.2.3'), true);
    assert.equal(satisfies('  1.5.0  ', '  ^1.2.3  '), true);
  });

  it('a non-string range fails closed (typeof guard)', () => {
    // The guard `typeof range !== 'string'` protects against a malformed manifest.
    assert.equal(satisfies('1.2.3', null as unknown as string), false);
    assert.equal(satisfies('1.2.3', undefined as unknown as string), false);
    assert.equal(satisfies('1.2.3', 123 as unknown as string), false);
  });
});
