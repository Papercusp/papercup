/**
 * resolveProjectHiveMembership — the "add into hive" membership-edge decision
 * (harnesses-tab-hive-model P-011). Pins the formal-vs-legacy precedence + the
 * standalone/unknown-scope cases.
 */
import { describe, test, expect } from 'vitest';
import { resolveProjectHiveMembership } from './projects';

const PROJECTS = [
  { slug: 'acme', harness_kind: 'hive' }, // a FORMAL Hive home
  { slug: 'legacy-root' }, // a plain root harness (no kind)
  { slug: 'acme-web', harness_kind: 'coding' },
];

describe('resolveProjectHiveMembership', () => {
  test('empty scope → no membership (standalone harness)', () => {
    const r = resolveProjectHiveMembership(PROJECTS, '');
    expect(r).toEqual({ ok: true, membership: null });
  });

  test('a formal kind:hive home → hive_slug membership', () => {
    const r = resolveProjectHiveMembership(PROJECTS, 'acme');
    expect(r).toEqual({ ok: true, membership: { kind: 'hive_slug', value: 'acme' } });
  });

  test('a non-hive root scope → legacy parent_slug membership', () => {
    const r = resolveProjectHiveMembership(PROJECTS, 'legacy-root');
    expect(r).toEqual({ ok: true, membership: { kind: 'parent_slug', value: 'legacy-root' } });
  });

  test('unknown scope → hive_not_found error', () => {
    const r = resolveProjectHiveMembership(PROJECTS, 'ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('hive_not_found');
  });

  test('whitespace scope is trimmed → standalone', () => {
    expect(resolveProjectHiveMembership(PROJECTS, '   ')).toEqual({ ok: true, membership: null });
  });
});
