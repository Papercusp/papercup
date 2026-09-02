/**
 * Unit tests for resolveCreateHiveMembership — the pure validation behind the
 * `harness:create { hive }` create-time membership producer
 * (shared-hive-federation-2026-06-08, D-010 create-time half).
 */
import { describe, expect, it } from 'vitest';
import { resolveCreateHiveMembership } from '../create-hive-membership';
import type { HarnessRegistry } from '../../../harness-registry';

const reg = (projects: Array<{ slug: string; harness_kind?: string; hive_slug?: string }>): HarnessRegistry =>
  ({ projects: projects.map((p) => ({ path: `/tmp/${p.slug}`, ...p })) }) as unknown as HarnessRegistry;

describe('resolveCreateHiveMembership', () => {
  it('returns the hive_slug when the target is a real Hive home (harness_kind:hive)', () => {
    const r = resolveCreateHiveMembership(reg([{ slug: 'acme', harness_kind: 'hive' }]), 'acme');
    expect(r).toEqual({ ok: true, hive_slug: 'acme' });
  });

  it('fails hive_not_found when no project has that slug', () => {
    const r = resolveCreateHiveMembership(reg([{ slug: 'acme', harness_kind: 'hive' }]), 'ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('hive_not_found');
      expect(r.message).toContain('ghost');
    }
  });

  it('fails not_a_hive when the slug exists but is a regular (non-hive) harness', () => {
    const r = resolveCreateHiveMembership(reg([{ slug: 'plain' }]), 'plain');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe('not_a_hive');
      expect(r.message).toContain('plain');
    }
  });

  it('fails not_a_hive when the target is itself a member harness (has hive_slug, not a home)', () => {
    const r = resolveCreateHiveMembership(
      reg([
        { slug: 'acme', harness_kind: 'hive' },
        { slug: 'acme-rd', hive_slug: 'acme' },
      ]),
      'acme-rd',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_a_hive');
  });

  it('resolves the correct Hive when several projects exist', () => {
    const r = resolveCreateHiveMembership(
      reg([
        { slug: 'plain' },
        { slug: 'acme', harness_kind: 'hive' },
        { slug: 'other-hive', harness_kind: 'hive' },
        { slug: 'acme-rd', hive_slug: 'acme' },
      ]),
      'other-hive',
    );
    expect(r).toEqual({ ok: true, hive_slug: 'other-hive' });
  });
});
