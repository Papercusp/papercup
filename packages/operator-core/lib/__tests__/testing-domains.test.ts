/**
 * P-042: Test the testing-domains registry.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, Phase 6.
 *
 * Covers:
 *  - defineTestDomain shape invariants (id uniqueness, sections non-empty,
 *    section id uniqueness, globs-or-runners required).
 *  - getTestDomain / listTestDomains lookup.
 *  - Tier ordering: quick < domain < surface.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defineTestDomain,
  getTestDomain,
  listTestDomains,
  _resetTestDomainRegistry,
  type TestDomain,
} from '../testing-domains';

function minimalDomain(id: string, overrides: Partial<TestDomain> = {}): TestDomain {
  return {
    id,
    label: id.toUpperCase(),
    description: 'test',
    tier: 'domain',
    sections: [{ id: 'all', label: 'All', globs: ['x/**/*.test.ts'] }],
    ...overrides,
  };
}

// The pure lane deliberately shares one module process across files. Preserve
// whatever registry the process had before these mutation tests, then restore
// it after every case so fixture domains cannot leak into a later consumer
// such as the generated-contract freshness assertion.
let priorDomains: TestDomain[] = [];
beforeEach(() => {
  priorDomains = listTestDomains();
  _resetTestDomainRegistry();
});
afterEach(() => {
  _resetTestDomainRegistry();
  for (const domain of priorDomains) defineTestDomain(domain);
});

describe('defineTestDomain', () => {
  it('registers a minimal domain', () => {
    const d = defineTestDomain(minimalDomain('voice'));
    expect(d.id).toBe('voice');
    expect(getTestDomain('voice')).toBe(d);
  });

  it('rejects duplicate domain ids', () => {
    defineTestDomain(minimalDomain('voice'));
    expect(() => defineTestDomain(minimalDomain('voice'))).toThrow(
      /duplicate domain id "voice"/,
    );
  });

  it('rejects a domain with zero sections', () => {
    expect(() =>
      defineTestDomain(minimalDomain('empty', { sections: [] })),
    ).toThrow(/has no sections/);
  });

  it('rejects duplicate section ids within a domain', () => {
    expect(() =>
      defineTestDomain(
        minimalDomain('dup', {
          sections: [
            { id: 'a', label: 'A', globs: ['x'] },
            { id: 'a', label: 'A2', globs: ['y'] },
          ],
        }),
      ),
    ).toThrow(/duplicate section id "a"/);
  });

  it('rejects a section that declares neither globs nor runners', () => {
    expect(() =>
      defineTestDomain(
        minimalDomain('bad', {
          sections: [{ id: 'orphan', label: 'Orphan' }],
        }),
      ),
    ).toThrow(/must declare globs, runners, or a role/);
  });

  it('accepts a section with runners only (no globs)', () => {
    const d = defineTestDomain(
      minimalDomain('smoke', {
        sections: [
          {
            id: 's',
            label: 'Smoke',
            runners: [{ kind: 'node', cmd: 'node scripts/foo.mjs' }],
          },
        ],
      }),
    );
    expect(d.sections[0].runners?.[0].kind).toBe('node');
  });
});

describe('listTestDomains tier ordering', () => {
  it('orders quick before domain before surface', () => {
    defineTestDomain(minimalDomain('z-surface', { tier: 'surface' }));
    defineTestDomain(minimalDomain('a-quick', { tier: 'quick' }));
    defineTestDomain(minimalDomain('m-domain', { tier: 'domain' }));

    const ordered = listTestDomains().map((d) => d.id);
    expect(ordered).toEqual(['a-quick', 'm-domain', 'z-surface']);
  });
});
