/**
 * catalog.test — the awaitable-key registry is the SINGLE SOURCE OF TRUTH
 * (event-await-discoverability-and-coverage-2026-07-03 P-002, D-005), so its
 * self-consistency is load-bearing: a malformed template or a param that doesn't
 * match its placeholders would make the sugar build a key nobody emits.
 */

import { describe, it, expect } from 'vitest';
import {
  EVENT_CATALOG,
  catalogEntry,
  buildKey,
  renderCatalog,
  sugaredFamilies,
} from './catalog';

describe('events catalog — registry integrity', () => {
  it('has unique family ids', () => {
    const ids = EVENT_CATALOG.map((e) => e.family);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every template placeholder is declared as a param, and vice versa', () => {
    for (const e of EVENT_CATALOG) {
      const placeholders = (e.keyTemplate.match(/<([a-zA-Z0-9_]+)>/g) ?? []).map((p) => p.slice(1, -1));
      const declared = e.params.map((p) => p.name);
      expect(new Set(placeholders), `${e.family} placeholders`).toEqual(new Set(declared));
      // params in declaration order must be the order they appear in the template
      expect(declared, `${e.family} param order`).toEqual(placeholders);
    }
  });

  it('keyTemplate is a colon-namespaced string with no whitespace', () => {
    for (const e of EVENT_CATALOG) {
      expect(e.keyTemplate, e.family).toMatch(/^[a-zA-Z0-9:<>_-]+$/);
      expect(e.keyTemplate.includes(':'), e.family).toBe(true);
    }
  });

  it('every sugar-bearing family names a distinct verb', () => {
    const verbs = sugaredFamilies().map((e) => e.sugar!);
    expect(new Set(verbs).size).toBe(verbs.length);
    for (const v of verbs) expect(v).toMatch(/^[a-z][a-z-]*:[a-z][a-z-]*$/);
  });
});

describe('buildKey', () => {
  it('interpolates a required param', () => {
    expect(buildKey('work-item', { id: 'WI-1234' })).toBe('work-item:status:WI-1234');
    expect(buildKey('lock', { ticket: 'abc' })).toBe('lock:grant:abc');
    expect(buildKey('plan-item', { slug: 'my-plan', id: 'P-014' })).toBe('plan-item:done:my-plan:P-014');
  });

  it('throws when a required param is missing', () => {
    expect(() => buildKey('work-item', {})).toThrow(/requires param 'id'/);
    expect(() => buildKey('service-up', {})).toThrow(/requires param 'name'/);
  });

  it('collapses an omitted OPTIONAL param to the global key (matches the real global emit)', () => {
    // deploy with no sha → the global `release:deployed` that actually fires today
    expect(buildKey('deploy', {})).toBe('release:deployed');
    expect(buildKey('deploy', { sha: '' })).toBe('release:deployed');
    expect(buildKey('git-sync', {})).toBe('git-sync:committed');
  });

  it('interpolates an OPTIONAL param when supplied (the precise per-sha key)', () => {
    expect(buildKey('deploy', { sha: 'abc123' })).toBe('release:deployed:abc123');
    expect(buildKey('git-sync', { sha: 'def456' })).toBe('git-sync:committed:def456');
  });

  it('gate-verdict keys scope per pipeline when supplied, global when omitted (EI-7646)', () => {
    expect(buildKey('checkpoint', {})).toBe('release:green');
    expect(buildKey('checkpoint', { pipeline: 'papercusp' })).toBe('release:green:papercusp');
    expect(buildKey('checkpoint-red', {})).toBe('green-checkpoint:red');
    expect(buildKey('checkpoint-red', { pipeline: 'papercup' })).toBe('green-checkpoint:red:papercup');
  });

  it('a no-param family is a literal key', () => {
    expect(buildKey('checkpoint')).toBe('release:green');
    expect(buildKey('checkpoint-red')).toBe('green-checkpoint:red');
    expect(buildKey('deploy-failed')).toBe('release:deploy-failed');
  });

  it('throws on an unknown family', () => {
    expect(() => buildKey('nope' as string)).toThrow(/unknown family/);
  });
});

describe('renderCatalog', () => {
  it('projects every entry with a ready-to-copy await example', () => {
    const rows = renderCatalog();
    expect(rows.length).toBe(EVENT_CATALOG.length);
    for (const r of rows) {
      expect(r.await_example).toBe(`events:await { event: "${r.key}" }`);
      expect(typeof r.awaitable_now).toBe('boolean');
    }
  });

  it('marks the verified-existing keys awaitable_now', () => {
    const byFamily = Object.fromEntries(renderCatalog().map((r) => [r.family, r]));
    // Grounded against real emit sites (2026-07-03):
    expect(byFamily['checkpoint'].awaitable_now).toBe(true); // release:green
    expect(byFamily['deploy-failed'].awaitable_now).toBe(true); // release:deploy-failed
    expect(byFamily['work-item-done'].awaitable_now).toBe(true); // work-item:done
    expect(byFamily['work-item'].awaitable_now).toBe(true); // work-item:status — P-101 LANDED (setWorkItemState emit)
    expect(byFamily['deploy'].awaitable_now).toBe(true); // release:deployed:<sha> — P-102 LANDED (deploy.ts dual-emit)
    expect(byFamily['git-sync'].awaitable_now).toBe(true); // git-sync:committed — P-102 LANDED (git-sync-action emit)
    expect(byFamily['service-up'].awaitable_now).toBe(true); // service:up:<name> — P-104 LANDED (service-health tick)
    expect(byFamily['service-down'].awaitable_now).toBe(true); // service:down:<name> — P-104 LANDED (service-health tick)
    expect(byFamily['plan-item'].awaitable_now).toBe(true); // plan-item:done:<slug>:<id> — P-105 LANDED (set-status)
    expect(byFamily['claim-released'].awaitable_now).toBe(true); // claim:released:<id> — P-105 LANDED (releaseWorkItem)
    expect(byFamily['fleet-drained'].awaitable_now).toBe(true); // fleet:drained:<slug> — WI-1830 LANDED (set-status plan-drain edge)
    expect(byFamily['session-compacted'].awaitable_now).toBe(true); // session:compacted:<owner> — P-103 LANDED (psu-host → emit-session-compacted CLI)
  });
});

describe('catalogEntry', () => {
  it('finds by family and returns undefined for unknown', () => {
    expect(catalogEntry('deploy')?.keyTemplate).toBe('release:deployed:<sha>');
    expect(catalogEntry('does-not-exist')).toBeUndefined();
  });
});
