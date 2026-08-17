/**
 * enforcement-tier-census.test.ts — plan coordination-spec-adoption-2026-08-03, P-002.
 *
 * The properties worth pinning are not "does it add up" but the two directions in
 * which this census can silently stop being true:
 *   - a NEW coordination verb must surface as tier debt without anyone listing it;
 *   - a declaration for a RENAMED/DELETED verb must be caught, because it keeps
 *     asserting enforcement that no longer exists and nothing else would notice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEnforcementTierCensus,
  selectCoordBehaviours,
  findStaleDeclarations,
  deriveSeeAlsoTiers,
  resolveTierDeclarations,
  loadCoordBehaviourAdoption,
  DECLARED_COORD_TIERS,
  ENFORCEMENT_TIER_RANK,
  UNDECLARED,
  type BehaviourAdoption,
  type TierDeclaration,
} from './enforcement-tier-census';
import { buildBuiltinToolCatalog } from '../static-tool-catalog';

const adoption = (m: Record<string, BehaviourAdoption>): ReadonlyMap<string, BehaviourAdoption> =>
  new Map(Object.entries(m));

const declared = (m: Record<string, TierDeclaration>): ReadonlyMap<string, TierDeclaration> =>
  new Map(Object.entries(m));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('buildEnforcementTierCensus', () => {
  it('reports an unlisted behaviour as tier DEBT rather than omitting it', () => {
    // The core anti-drift property: the behaviour list comes from the scan, so a
    // verb nobody declared still gets a row — it cannot vanish by being forgotten.
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:send', 'coord:brand-new-verb'],
      adoption: adoption({ 'coord:send': { calls: 1611, callers: 149 } }),
      windowDays: 7,
      declared: declared({
        'coord:send': { tier: 'schema-refusal', evidence: 'envelope validated at the tool boundary' },
      }),
    });

    const fresh = c.rows.find((r) => r.id === 'coord:brand-new-verb');
    expect(fresh).toBeDefined();
    expect(fresh?.tier).toBe(UNDECLARED);
    expect(fresh?.tierDebt).toBe(true);
    expect(fresh?.tierRank).toBeNull();
    expect(fresh?.evidence).toBeNull();
    expect(c.totals.undeclared).toBe(1);
    expect(c.totals.declared).toBe(1);
  });

  it('treats a behaviour absent from adoption as ZERO calls, not unknown', () => {
    // Absence from tool_invocations over the window IS the measurement — the zero
    // is the finding. Modelling it as "unknown" would let a dead verb hide.
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:vote'],
      adoption: adoption({}),
      windowDays: 7,
    });
    expect(c.rows[0].calls).toBe(0);
    expect(c.rows[0].callers).toBe(0);
    expect(c.totals.zeroCall).toBe(1);
  });

  it('flags a zero-call unenforced behaviour as a retirement CANDIDATE', () => {
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:vote'],
      adoption: adoption({}),
      windowDays: 7,
      declared: declared({ 'coord:vote': { tier: 'prompt-only', evidence: 'the playbook mentions it' } }),
    });
    expect(c.rows[0].retirementCandidate).toBe(true);
    expect(c.totals.retirementCandidates).toBe(1);
  });

  it('does NOT flag a zero-call behaviour that carries real enforcement', () => {
    // A tier-1–3 behaviour at zero calls is a DIFFERENT finding (built but
    // unreached), and D-001's retirement rule is explicitly about the ones that
    // cannot be given a tier. Conflating them would propose retiring working
    // machinery.
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:emit'],
      adoption: adoption({}),
      windowDays: 7,
      declared: declared({ 'coord:emit': { tier: 'auto-stamp', evidence: 'stamped at the emit chokepoint' } }),
    });
    expect(c.rows[0].calls).toBe(0);
    expect(c.rows[0].retirementCandidate).toBe(false);
    expect(c.totals.zeroCall).toBe(1);
    expect(c.totals.retirementCandidates).toBe(0);
  });

  it('leaves prompt-only UNRANKED and out of the enforced count (D-016: a prompt is not a tier)', () => {
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:walls'],
      adoption: adoption({ 'coord:walls': { calls: 3, callers: 2 } }),
      windowDays: 7,
      declared: declared({ 'coord:walls': { tier: 'prompt-only', evidence: 'prose only' } }),
    });
    expect(c.rows[0].tierRank).toBeNull();
    expect(c.totals.promptOnly).toBe(1);
    expect(c.totals.enforced).toBe(0);
    // Still "declared" — we know what enforces it (nothing). That is not the same
    // as the D-016/D-047 debt of never having been assessed.
    expect(c.totals.declared).toBe(1);
    expect(c.rows[0].tierDebt).toBe(false);
  });

  it('names a denominator for every ratio a reader could compute (D-003)', () => {
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:send', 'coord:read', 'coord:vote'],
      adoption: adoption({ 'coord:send': { calls: 1611, callers: 149 }, 'coord:read': { calls: 15, callers: 6 } }),
      windowDays: 7,
      declared: declared({
        'coord:send': { tier: 'schema-refusal', evidence: 'envelope validated at the boundary' },
      }),
    });
    expect(c.totals.behaviours).toBe(3);
    expect(c.totals.declared + c.totals.undeclared).toBe(c.totals.behaviours);
    expect(c.windowDays).toBe(7);
  });

  it('sorts strongest-first so the undeclared debt lands together at the bottom', () => {
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:zeta', 'coord:send', 'coord:alpha'],
      adoption: adoption({}),
      windowDays: 7,
      declared: declared({
        'coord:send': { tier: 'schema-refusal', evidence: 'boundary' },
      }),
    });
    expect(c.rows.map((r) => r.id)).toEqual(['coord:send', 'coord:alpha', 'coord:zeta']);
  });

  it('de-duplicates a name the scan sees twice', () => {
    const c = buildEnforcementTierCensus({
      behaviourIds: ['coord:send', 'coord:send'],
      adoption: adoption({ 'coord:send': { calls: 5, callers: 1 } }),
      windowDays: 7,
    });
    expect(c.rows).toHaveLength(1);
    expect(c.totals.behaviours).toBe(1);
  });
});

describe('selectCoordBehaviours', () => {
  it('keeps only the coord namespace and sorts', () => {
    expect(selectCoordBehaviours(['work_items:get', 'coord:send', 'plans:get', 'coord:ack'])).toEqual([
      'coord:ack',
      'coord:send',
    ]);
  });
});

describe('findStaleDeclarations', () => {
  it('catches a declaration whose verb no longer exists', () => {
    expect(
      findStaleDeclarations(
        ['coord:send'],
        declared({
          'coord:send': { tier: 'schema-refusal', evidence: 'boundary' },
          'coord:renamed-away': { tier: 'auto-stamp', evidence: 'stale' },
        }),
      ),
    ).toEqual(['coord:renamed-away']);
  });

  /**
   * THE GUARD THAT ACTUALLY BINDS. Runs against the REAL repo scan, so a rename
   * or deletion of a declared coordination verb fails here instead of leaving the
   * census quietly asserting enforcement for a name that no longer exists.
   */
  it('has no stale declarations against the real tool catalog', () => {
    const catalog = buildBuiltinToolCatalog(REPO_ROOT);
    // Guard the guard: if the scan ever returns nothing the assertion below would
    // pass vacuously while proving the opposite of what it claims.
    expect(selectCoordBehaviours(catalog).length).toBeGreaterThan(20);
    expect(findStaleDeclarations(catalog)).toEqual([]);
  });

  it('coerces PG bigint counts (which arrive as STRINGS) to numbers', async () => {
    // count(*) is bigint, and node-postgres hands bigint back as a string to
    // preserve precision. Without the coercion `calls === 0` would be false for
    // "0" and every zero-call verb — the entire point of this census — would be
    // silently misclassified as having calls.
    let query = '';
    const adoptionMap = await loadCoordBehaviourAdoption({
      workspaceId: 'papercusp-workspace',
      windowDays: 7,
      getSql: () => ((strings: TemplateStringsArray) => {
        query = strings.join('');
        return Promise.resolve([
          { tool_name: 'coord:send', calls: '1645', callers: '95' },
          { tool_name: 'coord:read', calls: '15', callers: '6' },
        ]) as never;
      }) as never,
    });
    expect(adoptionMap.get('coord:send')).toEqual({ calls: 1645, callers: 95 });
    expect(typeof adoptionMap.get('coord:read')?.calls).toBe('number');
    expect(query).toContain('harness_shared.is_agent_coord_owner_id(coord_owner_id, role)');
  });

  it('returns an empty map when the window has no coordination calls', async () => {
    const adoptionMap = await loadCoordBehaviourAdoption({
      workspaceId: 'papercusp-workspace',
      windowDays: 7,
      getSql: () => (async () => []) as never,
    });
    expect(adoptionMap.size).toBe(0);
  });

  /**
   * The RUNTIME behaviour-list seam. Its failure mode is not an exception — it is
   * a PARTIAL registry answering plausibly, which would silently shrink the
   * census denominator and report less debt than exists. That reads as progress.
   */
  describe('loadCoordRegistrySnapshot — the runtime seam', () => {
    const withRegistry = async (tools: Array<{ name: string; seeAlso?: unknown }>) => {
      vi.resetModules();
      vi.doMock('@papercusp/agent-mcp', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
        listAllProjectedTools: () =>
          tools.map((t) => ({ expose: { mcp: { name: t.name } }, seeAlso: t.seeAlso })),
      }));
      const mod = await import('./enforcement-tier-census');
      return mod.loadCoordRegistrySnapshot();
    };
    const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `coord:verb-${i}` }));

    afterEach(() => {
      vi.doUnmock('@papercusp/agent-mcp');
      vi.resetModules();
    });

    it('returns the coord verbs from the live registry, ignoring other groups', async () => {
      const snap = await withRegistry([
        ...filler(25),
        { name: 'work_items:claim' },
        { name: 'plans:get' },
      ]);
      expect(snap?.behaviourIds).toHaveLength(25);
      expect(snap?.behaviourIds.every((i) => i.startsWith('coord:'))).toBe(true);
    });

    it('REMOVES the signal when the registry looks partial, rather than shrinking the denominator', async () => {
      // The load-bearing case. A half-initialised registry returning 3 verbs would
      // otherwise publish "3 behaviours, 1 undeclared" — a well-formed, plausible,
      // wrong reading that looks like the debt shrank. Undefined removes the
      // signal instead; a census that counts zeros must never guess its total.
      expect(await withRegistry([{ name: 'coord:send' }, { name: 'coord:orient' }])).toBeUndefined();
      expect(await withRegistry([])).toBeUndefined();
    });

    it('derives see-also tiers from CROSS-GROUP pointers, not just coord tools', async () => {
      // The pointer that tiers coord:declare-intent lives on memory:remember.
      // Narrowing the sources to the coord slice first would drop exactly these.
      const snap = await withRegistry([
        ...filler(25),
        { name: 'memory:remember', seeAlso: ['coord:declare-intent (announce the lane)'] },
      ]);
      expect(snap?.derivedTiers.get('coord:declare-intent')?.tier).toBe('see-also');
    });
  });

  describe('deriveSeeAlsoTiers — tier 3 read off the registry instead of asserted', () => {
    it('accepts both entry shapes: a bare string and a structured pointer', () => {
      const d = deriveSeeAlsoTiers([
        { name: 'coord:presence', seeAlso: ['coord:roster { view:"live" } (the door)'] },
        { name: 'coord:glance', seeAlso: [{ tool: 'coord:catch-up', selector: '{ audience }' }] },
      ]);
      expect(d.get('coord:roster')?.tier).toBe('see-also');
      expect(d.get('coord:catch-up')?.tier).toBe('see-also');
    });

    it('credits the LEADING pointer only, never a verb named incidentally in its prose', () => {
      // An entry's prose routinely names other verbs; crediting those would invent
      // enforcement for a verb nothing actually points at.
      const d = deriveSeeAlsoTiers([
        { name: 'coord:send', seeAlso: ['coord:read (call coord:inbox first for the summary)'] },
      ]);
      expect(d.has('coord:read')).toBe(true);
      expect(d.has('coord:inbox')).toBe(false);
    });

    it('names the pointing tools as evidence, so the claim is falsifiable', () => {
      const d = deriveSeeAlsoTiers([
        { name: 'activity:recent', seeAlso: ['coord:inbox (your directed mail)'] },
        { name: 'coord:send', seeAlso: ['coord:inbox (your directed mail)'] },
      ]);
      const ev = d.get('coord:inbox')!.evidence;
      expect(ev).toContain('activity:recent');
      expect(ev).toContain('coord:send');
      expect(ev).toMatch(/DERIVED/);
    });

    it('IGNORES a function-form seeAlso rather than guessing its targets', () => {
      // Its targets depend on the actual tool result, so they are not knowable
      // without invoking it. Measured 2026-08-03: exactly two verbs
      // (coord:dispatch, coord:glance) are reachable ONLY this way, so they read
      // as debt they do not owe — the SAFE direction. Over-reporting debt is
      // recoverable; a tier nothing backs hides it.
      const d = deriveSeeAlsoTiers([
        { name: 'coord:presence', seeAlso: () => ['coord:glance (headline)'] },
      ]);
      expect(d.size).toBe(0);
    });
  });

  describe('resolveTierDeclarations — explicit beats derived', () => {
    it('keeps the STRONGER explicit tier when a verb is also cross-linked', () => {
      // coord:send is schema-refusal (tier 2) AND pointed at by seven tools. D-001
      // ranks 2 above 3, so a stray pointer must not downgrade it.
      const merged = resolveTierDeclarations(
        deriveSeeAlsoTiers([{ name: 'activity:report', seeAlso: ['coord:send (tell a peer)'] }]),
        declared({
          'coord:send': { tier: 'schema-refusal', evidence: 'envelope validated at the boundary' },
        }),
      );
      expect(merged.get('coord:send')?.tier).toBe('schema-refusal');
    });

    it('does not let a stray pointer silently upgrade a deliberate prompt-only verdict', () => {
      // "its only enforcement is prose" IS the finding (D-016). A pointer
      // appearing elsewhere must not erase it.
      const merged = resolveTierDeclarations(
        deriveSeeAlsoTiers([{ name: 'x:y', seeAlso: ['coord:vote (weigh in)'] }]),
        declared({ 'coord:vote': { tier: 'prompt-only', evidence: 'only the playbook asks for it' } }),
      );
      expect(merged.get('coord:vote')?.tier).toBe('prompt-only');
    });

    it('passes derived tiers through untouched when nothing explicit overlaps', () => {
      const merged = resolveTierDeclarations(
        deriveSeeAlsoTiers([{ name: 'x:y', seeAlso: ['coord:roster (who is around)'] }]),
        declared({}),
      );
      expect(merged.get('coord:roster')?.tier).toBe('see-also');
    });
  });

  it('every declaration carries concrete non-empty evidence', () => {
    // A declaration without a stated mechanism reads as covered while asserting
    // nothing falsifiable — worse than leaving it undeclared, which at least
    // counts as debt.
    for (const [id, d] of DECLARED_COORD_TIERS) {
      expect(d.evidence.trim().length, `${id} must state what enforces it`).toBeGreaterThan(20);
      expect(ENFORCEMENT_TIER_RANK).toHaveProperty(d.tier);
    }
  });
});
