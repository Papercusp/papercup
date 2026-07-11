/**
 * ref-hydrate tests (coord-authority-hardening-2026-07-11 P-001): the typed-ref
 * parse/budget/render pure core, and hydrateRefs with INJECTED resolvers (the
 * unit surface is DB-free by design — the default msg/work-item resolvers are
 * exercised by their consuming tools' integration tests).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  applyRefBudget,
  canonicalRefKey,
  clampSnippet,
  DEFAULT_REF_BUDGET,
  detectBodyRefs,
  GATE_REFS_FIELD,
  parseRefToken,
  readGateRefs,
  renderGateRefsSuffix,
  renderHydratedRef,
  renderHydratedRefs,
  renderReplyQuoteSuffix,
  type HydratableRef,
} from './ref-hydrate';
import { hydrateRefs, resolveGateRefStamps, type RefResolver } from './ref-hydrate-resolve';
import { findAnnouncementsForKey } from '../../events/await/store';

vi.mock('../../events/await/store', () => ({ findAnnouncementsForKey: vi.fn() }));

describe('parseRefToken', () => {
  it('parses each typed ref shape', () => {
    expect(parseRefToken('msg:mrgf42eg-0000-abc')).toEqual({ kind: 'msg', id: 'mrgf42eg-0000-abc' });
    expect(parseRefToken('WI-4070')).toEqual({ kind: 'work-item', id: 'WI-4070' });
    expect(parseRefToken('wi:wi-4070')).toEqual({ kind: 'work-item', id: 'WI-4070' });
    expect(parseRefToken('ei-9501')).toEqual({ kind: 'work-item', id: 'EI-9501' });
    expect(parseRefToken('F-12')).toEqual({ kind: 'work-item', id: 'F-12' });
    expect(parseRefToken('plan:my-plan-2026-07-11#P-004')).toEqual({
      kind: 'plan-item',
      slug: 'my-plan-2026-07-11',
      item: 'P-004',
    });
    expect(parseRefToken('gate:fleet:p2p-git:phase1-green')).toEqual({
      kind: 'gate',
      key: 'fleet:p2p-git:phase1-green',
    });
    expect(parseRefToken('owner-turn')).toEqual({ kind: 'owner-turn' });
  });

  it('returns null for non-refs (never throws)', () => {
    for (const junk of ['', '   ', 'hello', 'WI-', 'plan:#P-001', 'msg:', 'XWI-123']) {
      expect(parseRefToken(junk)).toBeNull();
    }
  });
});

describe('detectBodyRefs (P-008 auto-detect)', () => {
  it('finds word-bounded WI/EI ids, in order, de-duped', () => {
    const refs = detectBodyRefs('WI-4070 is blocked on EI-9501; see WI-4070 again');
    expect(refs).toEqual([
      { kind: 'work-item', id: 'WI-4070' },
      { kind: 'work-item', id: 'EI-9501' },
    ]);
  });

  it('caps at max and ignores embedded / F- shapes', () => {
    const refs = detectBodyRefs('WI-1 WI-2 WI-3 WI-4 and XWI-9 F-77', 3);
    expect(refs.map((r) => (r.kind === 'work-item' ? r.id : ''))).toEqual(['WI-1', 'WI-2', 'WI-3']);
  });

  it('is safe on empty input', () => {
    expect(detectBodyRefs('')).toEqual([]);
  });
});

describe('clampSnippet', () => {
  it('collapses whitespace to one verbatim line', () => {
    expect(clampSnippet('tell the fleet\n  to wind down,\t we will continue later', 200)).toBe(
      'tell the fleet to wind down, we will continue later',
    );
  });

  it('clamps with an ellipsis at the budget', () => {
    const out = clampSnippet('a'.repeat(300), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('applyRefBudget', () => {
  it('de-dupes by canonical key and keeps the first maxRefs', () => {
    const refs: HydratableRef[] = [
      { kind: 'work-item', id: 'WI-1' },
      { kind: 'work-item', id: 'WI-1' },
      { kind: 'msg', id: 'm1' },
      { kind: 'gate', key: 'g1' },
      { kind: 'work-item', id: 'WI-2' },
    ];
    const out = applyRefBudget(refs, { snippetChars: 200, maxRefs: 3 });
    expect(out.map(canonicalRefKey)).toEqual(['work-item:WI-1', 'msg:m1', 'gate:g1']);
  });
});

describe('render', () => {
  it('quotes verbatim snippets and marks unresolved refs explicitly', () => {
    expect(
      renderHydratedRef({
        ref: { kind: 'msg', id: 'm1' },
        ok: true,
        label: 'msg m1 (15179 → @fleet:p2p-git, 2026-07-11T09:01Z)',
        snippet: 'wind down',
      }),
    ).toBe('↪ msg m1 (15179 → @fleet:p2p-git, 2026-07-11T09:01Z): "wind down"');
    expect(
      renderHydratedRef({ ref: { kind: 'gate', key: 'g1' }, ok: false, label: 'gate:g1', snippet: '', error: 'not_found' }),
    ).toBe('↪ gate:g1 — unresolved (not_found)');
  });

  it('renders one line per ref', () => {
    const block = renderHydratedRefs([
      { ref: { kind: 'work-item', id: 'WI-1' }, ok: true, label: 'WI-1 [bug/wip]', snippet: 't' },
      { ref: { kind: 'work-item', id: 'WI-2' }, ok: false, label: 'work-item:WI-2', snippet: '', error: 'not_found' },
    ]);
    expect(block.split('\n')).toHaveLength(2);
  });

  it('reply-quote suffix (P-005): `⤷ re` + quoted verbatim snippet; unresolved stays visible', () => {
    expect(
      renderReplyQuoteSuffix({
        ref: { kind: 'msg', id: 'm1' },
        ok: true,
        label: 'msg m1 (15179 → 4c85f, 2026-07-11T09:01Z)',
        snippet: 'is the Mac app actually draining?',
      }),
    ).toBe(' ⤷ re msg m1 (15179 → 4c85f, 2026-07-11T09:01Z): "is the Mac app actually draining?"');
    expect(
      renderReplyQuoteSuffix({ ref: { kind: 'msg', id: 'm2' }, ok: false, label: 'msg:m2', snippet: '', error: 'not_found' }),
    ).toBe(' ⤷ re msg:m2 — unresolved (not_found)');
    expect(
      renderReplyQuoteSuffix({ ref: { kind: 'msg', id: 'm3' }, ok: true, label: 'msg m3', snippet: '' }),
    ).toBe(' ⤷ re msg m3');
  });
});

describe('gate refs (P-006) — read/render pure core + send-time stamping', () => {
  beforeEach(() => vi.mocked(findAnnouncementsForKey).mockReset());

  it('readGateRefs round-trips valid stamps, drops malformed entries, caps at 3', () => {
    const env = {
      [GATE_REFS_FIELD]: [
        { key: 'fleet:p2p:phase1-green', status: 'declared' },
        { key: '', status: 'declared' }, // blank key dropped
        { key: 'k2', status: 'god-mode' }, // forged status dropped
        'not-an-object',
        { key: 'k3', status: 'fired' },
        { key: 'k4', status: 'undeclared' },
        { key: 'k5', status: 'declared' }, // beyond cap
      ],
    };
    expect(readGateRefs(env)).toEqual([
      { key: 'fleet:p2p:phase1-green', status: 'declared' },
      { key: 'k3', status: 'fired' },
      { key: 'k4', status: 'undeclared' },
    ]);
    expect(readGateRefs({})).toEqual([]);
    expect(readGateRefs(null)).toEqual([]);
    expect(readGateRefs({ [GATE_REFS_FIELD]: 'nope' })).toEqual([]);
  });

  it('renderGateRefsSuffix renders each EXACT key with its status; empty → \'\'', () => {
    expect(
      renderGateRefsSuffix([
        { key: 'fleet:p2p:phase1-green', status: 'declared' },
        { key: 'deploy:done:papercusp', status: 'fired' },
      ]),
    ).toBe(' ⛩ gate fleet:p2p:phase1-green [declared]; gate deploy:done:papercusp [fired]');
    expect(renderGateRefsSuffix([])).toBe('');
  });

  it('resolveGateRefStamps: declared / fired / undeclared by store state; error → unknown; dedupe+cap', async () => {
    vi.mocked(findAnnouncementsForKey).mockImplementation(async (key: string) => {
      if (key === 'g-fired') return [{ firedAt: '2026-07-11', firedReason: 'event', note: null, subscriberId: 's' }] as never;
      if (key === 'g-declared') return [{ firedAt: null, firedReason: null, note: null, subscriberId: 's' }] as never;
      if (key === 'g-boom') throw new Error('store down');
      return [] as never;
    });
    expect(await resolveGateRefStamps(['g-fired', 'g-declared', 'g-nope'])).toEqual([
      { key: 'g-fired', status: 'fired' },
      { key: 'g-declared', status: 'declared' },
      { key: 'g-nope', status: 'undeclared' },
    ]);
    expect(await resolveGateRefStamps(['g-boom'])).toEqual([{ key: 'g-boom', status: 'unknown' }]);
    // dedupe + trim + cap at 3
    const stamps = await resolveGateRefStamps([' g-declared ', 'g-declared', 'g-fired', 'g-nope', 'g-extra']);
    expect(stamps.map((s) => s.key)).toEqual(['g-declared', 'g-fired', 'g-nope']);
  });
});

describe('hydrateRefs (injected resolvers — DB-free)', () => {
  const wiResolver: RefResolver = async (ref, budget) =>
    ref.kind === 'work-item' && ref.id === 'WI-4070'
      ? { label: 'WI-4070 [bug/wip @4c5f0]', snippet: clampSnippet('VM-local wedge', budget.snippetChars) }
      : null;

  it('resolves hits, tags misses not_found, keeps input order', async () => {
    const out = await hydrateRefs(
      [
        { kind: 'work-item', id: 'WI-4070' },
        { kind: 'work-item', id: 'WI-9999' },
      ],
      { resolvers: { 'work-item': wiResolver } },
    );
    expect(out.map((h) => [h.ok, h.error ?? ''])).toEqual([
      [true, ''],
      [false, 'not_found'],
    ]);
    expect(out[0].label).toContain('WI-4070');
  });

  it('degrades a missing resolver to resolver_not_installed (fail-soft)', async () => {
    const [h] = await hydrateRefs([{ kind: 'gate', key: 'g1' }]);
    expect(h.ok).toBe(false);
    expect(h.error).toBe('resolver_not_installed');
  });

  it('degrades a throwing resolver to resolve_error (never throws)', async () => {
    const boom: RefResolver = async () => {
      throw new Error('store down');
    };
    const [h] = await hydrateRefs([{ kind: 'work-item', id: 'WI-1' }], {
      resolvers: { 'work-item': boom },
    });
    expect(h).toMatchObject({ ok: false, error: 'resolve_error' });
  });

  it('applies the budget before resolving (dedupe + cap)', async () => {
    let calls = 0;
    const counting: RefResolver = async (ref) => {
      calls++;
      return { label: canonicalRefKey(ref), snippet: 's' };
    };
    const out = await hydrateRefs(
      [
        { kind: 'work-item', id: 'WI-1' },
        { kind: 'work-item', id: 'WI-1' },
        { kind: 'work-item', id: 'WI-2' },
        { kind: 'work-item', id: 'WI-3' },
        { kind: 'work-item', id: 'WI-4' },
      ],
      { resolvers: { 'work-item': counting }, budget: { ...DEFAULT_REF_BUDGET, maxRefs: 3 } },
    );
    expect(out).toHaveLength(3);
    expect(calls).toBe(3);
  });
});
