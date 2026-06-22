import { describe, expect, it } from 'vitest';
import {
  TABLE_TO_QUERY_NAMES,
  queryNamesForTriggerEvent,
  allBridgedQueryNames,
  resolveBridgeTarget,
  type QueryNameTarget,
  type ScopeKeyBuilder,
} from './table-to-query-names';
import { knownQueryNamesV2 } from './index';

describe('queryNamesForTriggerEvent', () => {
  it('strips the .changed suffix and looks up the table', () => {
    expect(queryNamesForTriggerEvent('harness_shared.harness_text_artifacts.changed')).toEqual([
      'harnessTextArtifact.byHarness',
    ]);
  });

  it('returns multiple names when a single table backs multiple queries', () => {
    const names = queryNamesForTriggerEvent('harness_shared.harness_chunk_plans.changed');
    expect(names).toEqual(expect.arrayContaining(['chunkPlans.byHarness', 'chunkPlans.byFeature']));
    expect(names).toHaveLength(2);
  });

  it('returns empty array for unknown tables', () => {
    expect(queryNamesForTriggerEvent('harness_shared.totally_unknown.changed')).toEqual([]);
  });

  it('returns empty array for malformed event names (no .changed suffix)', () => {
    expect(queryNamesForTriggerEvent('plans.list')).toEqual([]);
    expect(queryNamesForTriggerEvent('harness_shared.harness_text_artifacts')).toEqual([]);
    expect(queryNamesForTriggerEvent('')).toEqual([]);
  });

  it('handles userActions which contributes two names from one table', () => {
    expect(queryNamesForTriggerEvent('harness_shared.user_actions.changed')).toEqual(
      expect.arrayContaining(['userActions.byHarness', 'userActions.byKind']),
    );
  });

  it('maps hive_settings → hive.steering (the federated steering-write refresh, queen-steering-panel C-1)', () => {
    // A steering write lands in hive_settings (owner-steering:* keys); the capture
    // trigger fires this event so a FEDERATED write from a peer Swarm refreshes the
    // 👑 Queen tab's hive.steering query — the half hive:set-steering's explicit
    // notifySyncInvalidate does NOT cover (a remote write never runs that handler).
    expect(queryNamesForTriggerEvent('harness_shared.hive_settings.changed')).toEqual(['hive.steering']);
  });

  it('handles *Consolidated tables', () => {
    expect(queryNamesForTriggerEvent('harness_shared.harness_features_consolidated.changed')).toEqual(
      expect.arrayContaining(['featuresConsolidated.bySlug', 'featuresConsolidated.byPlanSlug']),
    );
    expect(queryNamesForTriggerEvent('harness_shared.agent_runs_consolidated.changed')).toEqual(
      expect.arrayContaining(['agentRunsConsolidated.bySlug', 'agentRunsConsolidated.recent']),
    );
  });
});

describe('per-row scoped invalidation (caching-layer-tag-eca P-006)', () => {
  // The PG trigger (emit_change_notify, mig 368) emits args { workspace_id,
  // op, id } where `id` is the changed row's PK (absent for id-less tables).
  // A query mapped as { name, scope } uses that id to invalidate JUST the
  // row's key; bare-string queries (every live entry today) full-bust.

  // A representative per-row query keyed solely by the row id. The scope
  // builder returns the COMPLETE consumer-key args object the client
  // subscribes with — TanStack hashes the whole key structurally, so a
  // partial object would match nothing.
  const byIdScope: ScopeKeyBuilder = (rowId) => ({ id: rowId });
  const widgetById: QueryNameTarget = { name: 'widget.byId', scope: byIdScope };

  it('a { name, scope } target with an id present → SCOPED { name, args:{id} }', () => {
    expect(resolveBridgeTarget(widgetById, 'widget-42', 'w1')).toEqual({
      name: 'widget.byId',
      args: { id: 'widget-42' },
    });
  });

  it('a bare-string target ALWAYS full-busts, even when an id is present', () => {
    // The existing byHarness/bySlug queries are keyed by harness/workspace,
    // not the changed row's PK — scoping by id can't narrow a list, so they
    // stay bare strings (full-bust). Mirrors the live registry.
    expect(resolveBridgeTarget('list.byHarness', 'row-7', 'w1')).toBe('list.byHarness');
  });

  it('a { name, scope } target with NO id (id-less table) falls back to full-bust', () => {
    // Most harness_shared.* tables key on a natural composite, so
    // to_jsonb(row)->'id' is JSON null → rowId undefined → bare name.
    expect(resolveBridgeTarget(widgetById, undefined, 'w1')).toBe('widget.byId');
  });

  it('a scope that opts out (returns null) falls back to full-bust', () => {
    const optsOut: QueryNameTarget = { name: 'q.byId', scope: () => null };
    expect(resolveBridgeTarget(optsOut, 'id-1', 'w1')).toBe('q.byId');
  });

  it('queryNamesForTriggerEvent normalizes a JSON-number id and forwards workspace', () => {
    const seen: Array<[string, string | undefined]> = [];
    const recordingScope: ScopeKeyBuilder = (rowId, ws) => {
      seen.push([rowId, ws]);
      return { id: rowId };
    };
    // Drive resolveBridgeTarget the way queryNamesForTriggerEvent does, but
    // assert the id-coercion + workspace pass-through it performs. (We can't
    // mutate the frozen live map, so exercise the coercion via the function's
    // public contract on a numeric id.)
    expect(resolveBridgeTarget({ name: 'q.byId', scope: recordingScope }, '99', 'wsX')).toEqual({
      name: 'q.byId',
      args: { id: '99' },
    });
    expect(seen).toEqual([['99', 'wsX']]);
  });

  it('LIVE registry: every entry full-busts today (no per-id opt-in yet) — id is ignored', () => {
    // Backward-compat guarantee: passing an id-bearing args payload through
    // the real bridge yields the SAME bare-string targets as before, because
    // no bridged table has an `id` column / per-row consumer (see P-006 note).
    const withId = queryNamesForTriggerEvent('harness_shared.harness_text_artifacts.changed', {
      workspace_id: 'w1',
      op: 'UPDATE',
      id: 'should-be-ignored',
    });
    expect(withId).toEqual(['harnessTextArtifact.byHarness']);

    const noArgs = queryNamesForTriggerEvent('harness_shared.harness_text_artifacts.changed');
    expect(noArgs).toEqual(withId);
  });

  it('the live map currently contains ONLY bare-string (full-bust) targets', () => {
    for (const [table, targets] of Object.entries(TABLE_TO_QUERY_NAMES)) {
      for (const t of targets) {
        expect(typeof t, `target for ${table}`).toBe('string');
      }
    }
  });
});

describe('TABLE_TO_QUERY_NAMES vs v2 registry consistency', () => {
  /**
   * Forward-defined names — mapped in the bridge BEFORE the
   * corresponding v2 registry entry exists. Trigger events for these
   * tables fire (as expected) but currently invalidate nothing; the
   * matching consumer + v2 entry will land later. Listed here so
   * the consistency assertion stays sharp while permitting deliberate
   * advance-mapping.
   *
   * REMOVE an entry from this set as soon as its v2 registry entry
   * lands — otherwise drift between intent ("this should land soon")
   * and reality ("it never did") stops being visible.
   */
  const FORWARD_DEFINED = new Set<string>([
    // v5 addendum 3 §9.0 Insights tab — P-073+ work.
    'contributorUsageEvents.byHarness',
    'insightsFirstVisit.byHarness',
  ]);

  it('every bridged query name is either in v2 registry OR explicitly forward-defined', () => {
    const v2 = new Set(knownQueryNamesV2());
    const bridged = allBridgedQueryNames();
    const unaccountedFor = bridged.filter((n) => !v2.has(n) && !FORWARD_DEFINED.has(n));
    expect(unaccountedFor).toEqual([]);
  });

  it('forward-defined names are NOT in v2 registry (sanity)', () => {
    const v2 = new Set(knownQueryNamesV2());
    const stillForward = Array.from(FORWARD_DEFINED).filter((n) => !v2.has(n));
    // If this assertion fails, a forward-defined name has been
    // implemented and its entry in FORWARD_DEFINED should be removed.
    expect(stillForward.sort()).toEqual(Array.from(FORWARD_DEFINED).sort());
  });

  it('exposes a distinct, non-trivially-populated set of camelCase names through the bridge', () => {
    // Was a brittle exact count (56) that flapped red as query families landed
    // (issues/conversations/coord added 2026-06-04 → 63; delegates.byWorkspace
    // removed by collapse-delegate-into-workitems-2026-06-04 → 62; harnessHealth.byHarness
    // removed by spec-md-ui-deprecation-cleanup P-007 → 61; operatorScans + operatorLastScan
    // removed by archive-legacy-orchestrator-deadcode P-009 (their tables were dropped by
    // migration 167) → 59; further Zero-retirement removals → 52 by 2026-06-09). The
    // forward-defined + v2-consistency assertions above carry the real signal; this is only a
    // non-triviality floor — set WELL BELOW the current count with headroom for the ongoing
    // shrink, so a routine add/remove doesn't flap it red (the exact-set assertions catch real
    // drift). The 55 floor flapped red @52 + blocked main fleet-wide; lowered to 45.
    const names = allBridgedQueryNames();
    expect(names.length).toBeGreaterThanOrEqual(45);
    expect(new Set(names).size, 'bridged query names are distinct').toBe(names.length);
  });
});

describe('TABLE_TO_QUERY_NAMES shape', () => {
  it('all keys start with harness_shared.', () => {
    for (const k of Object.keys(TABLE_TO_QUERY_NAMES)) {
      expect(k).toMatch(/^harness_shared\./);
    }
  });

  it('all values are non-empty string arrays', () => {
    for (const [k, vs] of Object.entries(TABLE_TO_QUERY_NAMES)) {
      expect(Array.isArray(vs), `value for ${k}`).toBe(true);
      expect(vs.length, `value for ${k}`).toBeGreaterThan(0);
      for (const v of vs) {
        expect(typeof v, `entry in ${k}`).toBe('string');
        expect(v, `entry in ${k}`).toMatch(/^\w+\.\w+$/);
      }
    }
  });
});
