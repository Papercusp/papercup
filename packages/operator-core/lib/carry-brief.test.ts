/**
 * carry-brief — unit tests (compaction-continuity-hardening-2026-07-07 P-003).
 *
 * The builder is exercised through its injectable seams (no PG); the renderers
 * are pure. The load-bearing contracts:
 *   - every read leg is independently best-effort (a throwing reader yields an
 *     empty section, never a failed brief);
 *   - the focus renderer is HARD-capped and pointer-styled (ids, not copies);
 *   - the cold-extras renderer skips empty sections and caps per-entry bytes.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCarryBrief,
  readHeldWorkItems,
  renderCarryBriefFocus,
  renderCarryBriefColdExtras,
  renderCarryBriefText,
  deriveCarryQueryHandles,
  renderCarryQueryHandlesBlock,
  CARRY_BRIEF_FOCUS_MAX,
  CARRY_BRIEF_MAX_FACTS,
  CARRY_BRIEF_MAX_AWAITS,
  CARRY_QUERY_HANDLES_MAX,
  CARRY_QUERY_HANDLES_HEADING,
  type CarryBrief,
  type BuildCarryBriefOpts,
} from './carry-brief';

/** Minimal tagged-template `sql` stub returning fixed `engineer_issues` rows. */
function fakeIssuesSql(rows: Array<{ issue_id: string; title: string | null; body: string | null; scope: string }>) {
  return ((_strings: TemplateStringsArray, ..._vals: unknown[]) => Promise.resolve(rows)) as unknown as never;
}

function fullOpts(overrides: Partial<BuildCarryBriefOpts> = {}): BuildCarryBriefOpts {
  return {
    workspaceId: 'ws-test',
    getLoopStatusFn: async () => ({ harnessSlug: 'papercusp', active: true, intervalSec: 120 }),
    getLoopCarryNoteWithMetaFn: async () => ({
      note: '## Did\nlanded the thing\n\n## Next action\nship P-004',
      updatedAtMs: Date.now() - 5 * 60_000,
    }),
    readHeldWorkItemsFn: async () => [
      {
        id: 'WI-3319',
        title: 'Shared carry-brief builder',
        body: 'One function assembles the carry brief.',
        harness: 'papercusp',
        checkpoint: 'wired request-compaction; watchdog next',
      },
    ],
    listOwnerFactsFn: async () => [
      { key: 'zombie-pids-wall', body: '3 zombie PIDs await owner OK to kill' },
    ],
    listActiveAwaitsFn: async () => [
      { eventKey: 'coord:inbox-wake:su-abc', note: 'always-armed inbox-wake' },
      { eventKey: 'deploy:done:release-77', note: 'waiting on the green deploy' },
    ],
    getFleetFn: async () => ({ slug: 'bug-drain', role: 'leader' }),
    listOpenDirectivesFn: async () => ({ rows: [], totalOpen: 0 }),
    ...overrides,
  };
}

/** An open owner-directive row (EI-11484) for the render tests. */
function directive(id: number, text: string) {
  return {
    id,
    workspaceId: 'ws-test',
    ownerId: 'owner',
    sessionRef: null,
    sourceTurnRef: null,
    verbatimText: text,
    recordedBy: 'su-abc',
    createdAtMs: Date.now() - 60_000,
    dispositionedAtMs: null,
    dispositionStatus: null,
    dispositionNote: null,
    dispositionedBy: null,
  };
}

describe('buildCarryBrief — assembly + per-leg fail-soft', () => {
  it('assembles every section from the injected readers', async () => {
    const brief = await buildCarryBrief('su-abc', fullOpts());
    expect(brief.ownerId).toBe('su-abc');
    expect(brief.loop).toMatchObject({ harness: 'papercusp', active: true, intervalSec: 120 });
    expect(brief.loop?.carryNote).toContain('ship P-004');
    expect(brief.loop?.carryNoteUpdatedAtMs).toBeTypeOf('number');
    expect(brief.heldItems.map((h) => h.id)).toEqual(['WI-3319']);
    expect(brief.facts).toEqual([
      { key: 'zombie-pids-wall', body: '3 zombie PIDs await owner OK to kill' },
    ]);
    expect(brief.fleet).toEqual({ slug: 'bug-drain', role: 'leader' });
  });

  it('filters infra inbox-wake awaits and keeps real ones', async () => {
    const brief = await buildCarryBrief('su-abc', fullOpts());
    expect(brief.awaits).toEqual([
      { eventKey: 'deploy:done:release-77', note: 'waiting on the green deploy' },
    ]);
  });

  it('caps facts and awaits at the section bounds', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOwnerFactsFn: async () =>
          Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, body: `b${i}` })),
        listActiveAwaitsFn: async () =>
          Array.from({ length: 30 }, (_, i) => ({ eventKey: `ev:${i}`, note: null })),
      }),
    );
    expect(brief.facts.length).toBe(CARRY_BRIEF_MAX_FACTS);
    expect(brief.awaits.length).toBe(CARRY_BRIEF_MAX_AWAITS);
  });

  it('a throwing leg yields that section empty, never a failed brief', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopStatusFn: async () => {
          throw new Error('pg down');
        },
        readHeldWorkItemsFn: async () => {
          throw new Error('pg down');
        },
        listOwnerFactsFn: async () => {
          throw new Error('pg down');
        },
        listActiveAwaitsFn: async () => {
          throw new Error('pg down');
        },
        getFleetFn: async () => {
          throw new Error('pg down');
        },
        listOpenDirectivesFn: async () => {
          throw new Error('pg down');
        },
      }),
    );
    expect(brief).toEqual({
      ownerId: 'su-abc',
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      // P-026 leg (b) (WI-5141): facts is empty, so the staleness leg short-circuits
      // to [] without even reaching its own throwing seam here — still asserted.
      factsStaleness: [],
      awaits: [],
      fleet: null,
    });
  });

  it('parses open walls out of the loop note (P-006) — structured rows on the brief', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        getLoopCarryNoteWithMetaFn: async () => ({
          note:
            '## Next action\nship P-006\n\n## Walls\n' +
            '- 3 zombie PIDs 95902/200903/220406 await owner OK to kill — re-check: ps -o pid,rss -p 95902,200903,220406 (since 2026-07-07T12:00:00.000Z)',
          updatedAtMs: Date.now(),
        }),
      }),
    );
    expect(brief.walls).toEqual([
      {
        claim: '3 zombie PIDs 95902/200903/220406 await owner OK to kill',
        recheck: 'ps -o pid,rss -p 95902,200903,220406',
        sinceMs: Date.parse('2026-07-07T12:00:00.000Z'),
      },
    ]);
    // The note itself stays verbatim on the brief (walls included).
    expect(brief.loop?.carryNote).toContain('## Walls');
  });

  it('a loop with no carry-note still reports the loop (note null)', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({ getLoopCarryNoteWithMetaFn: async () => ({ note: null, updatedAtMs: null }) }),
    );
    expect(brief.loop).toMatchObject({ harness: 'papercusp', carryNote: null });
  });

  it('no loop routine ⇒ loop null', async () => {
    const brief = await buildCarryBrief('su-abc', fullOpts({ getLoopStatusFn: async () => null }));
    expect(brief.loop).toBeNull();
  });
});

describe('renderCarryBriefFocus — the /compact focus line', () => {
  it('names the real anchors as pointers, not copies', async () => {
    const focus = renderCarryBriefFocus(await buildCarryBrief('su-abc', fullOpts()));
    expect(focus).toContain('WI-3319');
    expect(focus).toContain('POINTERS');
    expect(focus).toContain('armed loop @papercusp 120s');
    expect(focus).toContain('zombie-pids-wall');
    expect(focus).toContain('deploy:done:release-77');
    expect(focus).toContain('fleet bug-drain (leader)');
    // The standing preserve set stays first; the drop clause survives.
    expect(focus.startsWith('keep the identity block')).toBe(true);
    expect(focus).toContain('drop resolved tool output');
    // It must NOT copy checkpoint/note bodies.
    expect(focus).not.toContain('wired request-compaction');
    expect(focus).not.toContain('ship P-004');
  });

  it('an empty brief renders exactly the standing preserve set', () => {
    const empty: CarryBrief = {
      ownerId: 'x',
      loop: null,
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const focus = renderCarryBriefFocus(empty);
    expect(focus).toBe(
      'keep the identity block, the active plan and its open items, unverified claims awaiting owner confirmation, and owner-gated walls; drop resolved tool output and superseded state.',
    );
  });

  it('carries open walls VERBATIM, ahead of held items (P-006)', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      loop: null,
      heldItems: [{ id: 'WI-1', title: null, body: null, harness: 'h', checkpoint: null }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [{ claim: 'zombie PIDs await owner OK', recheck: 'ps -p 95902', sinceMs: 1 }],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const focus = renderCarryBriefFocus(brief);
    expect(focus).toContain('OPEN WALLS (carry verbatim, do not re-declare resolved): "zombie PIDs await owner OK"');
    expect(focus.indexOf('OPEN WALLS')).toBeLessThan(focus.indexOf('WI-1'));
  });

  it('is HARD-capped at the focus max, ellipsis-marked, for any brief size', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        readHeldWorkItemsFn: async () =>
          Array.from({ length: 6 }, (_, i) => ({
            id: `WI-${9000 + i}`,
            title: 'long '.repeat(40),
            body: null,
            harness: 'papercusp',
            checkpoint: null,
          })),
        listOwnerFactsFn: async () =>
          Array.from({ length: 8 }, (_, i) => ({ key: `a-very-long-standing-fact-key-${i}`, body: 'x' })),
      }),
    );
    const focus = renderCarryBriefFocus(brief);
    expect(focus.length).toBeLessThanOrEqual(CARRY_BRIEF_FOCUS_MAX);
    expect(focus.endsWith('…')).toBe(true);
    // Held-item ids outrank facts under truncation (ordered most-load-bearing first).
    expect(focus).toContain('WI-9000');
  });
});

describe('renderCarryBriefColdExtras — the cold-anchor sections after the note', () => {
  it('renders held items with capped checkpoints, facts, awaits, and the fleet pointer', async () => {
    const out = renderCarryBriefColdExtras(await buildCarryBrief('su-abc', fullOpts()));
    expect(out).toContain('You still HOLD these work-items');
    expect(out).toContain('WI-3319 — Shared carry-brief builder');
    expect(out).toContain('checkpoint: wired request-compaction; watchdog next');
    expect(out).toContain('zombie-pids-wall: 3 zombie PIDs await owner OK to kill');
    expect(out).toContain('armed awaits are still live');
    expect(out).toContain('deploy:done:release-77');
    expect(out).toContain('Fleet: you are in "bug-drain" as leader');
    // The loop note is the injection core, NOT part of the extras.
    expect(out).not.toContain('ship P-004');
  });

  it('returns "" when the brief carries nothing beyond the loop note', () => {
    const empty: CarryBrief = {
      ownerId: 'x',
      loop: { harness: 'h', active: true, intervalSec: 60, carryNote: 'n', carryNoteUpdatedAtMs: 1 },
      heldItems: [],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };
    expect(renderCarryBriefColdExtras(empty)).toBe('');
  });

  it('renders open walls FIRST, as verbatim rows with re-check commands (P-006)', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      loop: null,
      heldItems: [{ id: 'WI-1', title: null, body: null, harness: 'h', checkpoint: null }],
      directives: [],
      directivesTotalOpen: 0,
      walls: [
        { claim: 'zombie PIDs await owner OK', recheck: 'ps -p 95902', sinceMs: 1 },
        { claim: 'capital arming pending owner', sinceMs: 2 },
      ],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const out = renderCarryBriefColdExtras(brief);
    expect(out).toContain('⛔ OPEN WALLS');
    expect(out).toContain('  • zombie PIDs await owner OK — re-check: ps -p 95902');
    expect(out).toContain('  • capital arming pending owner');
    expect(out.indexOf('OPEN WALLS')).toBeLessThan(out.indexOf('You still HOLD'));
  });

  it('caps a long checkpoint and flags a missing one', () => {
    const brief: CarryBrief = {
      ownerId: 'x',
      loop: null,
      heldItems: [
        { id: 'WI-1', title: null, body: null, harness: 'h', checkpoint: 'y'.repeat(2000) },
        { id: 'WI-2', title: null, body: null, harness: 'h', checkpoint: null },
      ],
      directives: [],
      directivesTotalOpen: 0,
      walls: [],
      facts: [],
      awaits: [],
      fleet: null,
    };
    const out = renderCarryBriefColdExtras(brief);
    const ckptLine = out.split('\n').find((l) => l.includes('checkpoint: yyy'))!;
    expect(ckptLine.length).toBeLessThan(600);
    expect(ckptLine.endsWith('…')).toBe(true);
    expect(out).toContain('(no checkpoint written — read the item via work_items:get before acting)');
  });
});

describe('renderCarryBriefText — the full brief (P-004 recovery-hook payload)', () => {
  it('leads with the loop note + write age, then the extras sections', async () => {
    const now = Date.now();
    const out = renderCarryBriefText(await buildCarryBrief('su-abc', fullOpts()), now);
    expect(out).toContain('Armed loop @papercusp (active, every 120s)');
    expect(out).toContain('written 5m ago');
    expect(out).toContain('ship P-004'); // the note itself, verbatim
    expect(out.indexOf('Armed loop')).toBeLessThan(out.indexOf('You still HOLD'));
  });

  it('a loop with no note says so instead of rendering an empty block', async () => {
    const out = renderCarryBriefText(
      await buildCarryBrief(
        'su-abc',
        fullOpts({ getLoopCarryNoteWithMetaFn: async () => ({ note: null, updatedAtMs: null }) }),
      ),
    );
    expect(out).toContain('No carry-note written.');
  });
});

describe('owner directives in the brief (EI-11484)', () => {
  it('builds the directives section from the injected reader', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOpenDirectivesFn: async () => ({ rows: [directive(9, 'resume all the sessions')], totalOpen: 1 }),
      }),
    );
    expect(brief.directives.map((d) => d.id)).toEqual([9]);
    expect(brief.directivesTotalOpen).toBe(1);
  });

  it('renderCarryBriefText renders open directives FIRST — above the loop contract — and never twice', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOpenDirectivesFn: async () => ({
          rows: [directive(9, 'resume all the sessions active in the last half hour')],
          totalOpen: 1,
        }),
      }),
    );
    const out = renderCarryBriefText(brief);
    expect(out).toContain('OPEN OWNER DIRECTIVES');
    expect(out.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(out.indexOf('Armed loop'));
    expect(out).toContain('"resume all the sessions active in the last half hour"');
    // rendered once, not re-rendered by the extras leg
    expect(out.match(/OPEN OWNER DIRECTIVES/g)!.length).toBe(1);
  });

  it('renderCarryBriefColdExtras renders directives ahead of walls and held items', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOpenDirectivesFn: async () => ({ rows: [directive(4, 'ship it now')], totalOpen: 1 }),
      }),
    );
    const out = renderCarryBriefColdExtras(brief);
    expect(out.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(out.indexOf('You still HOLD'));
  });

  it('the focus line carries directive IDS as pointers, ahead of walls', async () => {
    const brief = await buildCarryBrief(
      'su-abc',
      fullOpts({
        listOpenDirectivesFn: async () => ({ rows: [directive(4, 'ship it now')], totalOpen: 1 }),
      }),
    );
    const focus = renderCarryBriefFocus(brief);
    expect(focus).toContain('OPEN OWNER DIRECTIVES #4');
    expect(focus.indexOf('OPEN OWNER DIRECTIVES')).toBeLessThan(focus.indexOf('zombie-pids-wall'));
    expect(focus).not.toContain('ship it now'); // pointers, not copies
  });
});

describe('readHeldWorkItems — scope→harness resolution (EI-8813 regression)', () => {
  it('resolves a harness-scoped item to its concrete slug', async () => {
    const held = await readHeldWorkItems('su-abc', 'ws-test', {
      sql: fakeIssuesSql([
        { issue_id: 'WI-1', title: 't', body: 'b', scope: 'harness:papercusp' },
      ]),
      getWorkItemCheckpointFn: async (ref) => `harness=${ref.harness}`,
    });
    expect(held).toEqual([{ id: 'WI-1', title: 't', body: 'b', harness: 'papercusp', checkpoint: 'harness=papercusp', checkpointUpdatedAtMs: null }]);
  });

  it('resolves an operator-scope (harness-null) item to null — NEVER a guessed slug', async () => {
    // Before the fix, a scope that didn't start with 'harness:' fell back to the
    // literal string 'papercup' (misspelled, and not the checkpoint store's
    // wildcard sentinel) — mismatching the key work_items:checkpoint actually
    // wrote under and silently losing the checkpoint (EI-8813).
    const held = await readHeldWorkItems('su-abc', 'ws-test', {
      sql: fakeIssuesSql([
        { issue_id: 'EI-8810', title: 't', body: 'b', scope: 'operator' },
      ]),
      getWorkItemCheckpointFn: async (ref) => {
        expect(ref.harness).toBeNull();
        return 'the real checkpoint';
      },
    });
    expect(held).toEqual([
      { id: 'EI-8810', title: 't', body: 'b', harness: null, checkpoint: 'the real checkpoint', checkpointUpdatedAtMs: null },
    ]);
  });
});

describe('readHeldWorkItems — EI-9013 (feature-family coverage + workspace canonicalization)', () => {
  /** Tagged-template sql stub that CAPTURES the query text + params it receives. */
  function capturingSql(rows: Array<{ issue_id: string; title: string | null; body: string | null; scope: string }>) {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      calls.push({ text: strings.join('¶'), params: vals });
      return Promise.resolve(rows);
    }) as unknown as never;
    return { sql, calls };
  }

  it('queries work_items DIRECTLY, covering the feature/chunk family the engineer_issues view excludes', async () => {
    // The incident (EI-9013): WI-3535 — a held FEATURE item — never appeared in the
    // post-compaction fold, because this read went through the engineer_issues VIEW
    // (item_kind IN bug/change/task only). Pin that the query now targets work_items
    // and carries BOTH per-family branches.
    const { sql, calls } = capturingSql([
      { issue_id: 'WI-3535', title: 'feature item', body: 'b', scope: 'harness:papercusp' },
    ]);
    const held = await readHeldWorkItems('su-abc', 'ws-test', {
      sql,
      getWorkItemCheckpointFn: async () => 'feature checkpoint',
    });
    expect(held).toEqual([
      { id: 'WI-3535', title: 'feature item', body: 'b', harness: 'papercusp', checkpoint: 'feature checkpoint', checkpointUpdatedAtMs: null },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('harness_shared.work_items');
    expect(calls[0]!.text).not.toContain('engineer_issues');
    expect(calls[0]!.text).toContain("item_kind IN ('feature', 'chunk')");
    expect(calls[0]!.text).toContain("item_kind IN ('bug', 'change', 'task')");
  });

  it("canonicalizes a wildcard '*' workspace to the concrete one for BOTH the query and the checkpoint reads", async () => {
    // An unscoped su session's ctx.workspaceId is the literal '*' — previously this
    // scoped the held-items query + checkpoint reads to a workspace with no rows,
    // so the fold showed NOTHING held (the other half of EI-9013).
    const prior = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = 'resolved-concrete-ws';
    try {
      const { sql, calls } = capturingSql([
        { issue_id: 'WI-1', title: 't', body: 'b', scope: 'harness:h1' },
      ]);
      const checkpointRefs: Array<{ workspaceId?: string }> = [];
      await readHeldWorkItems('su-abc', '*', {
        sql,
        getWorkItemCheckpointFn: async (ref) => {
          checkpointRefs.push(ref);
          return null;
        },
      });
      expect(calls[0]!.params).toContain('resolved-concrete-ws');
      expect(calls[0]!.params).not.toContain('*');
      expect(checkpointRefs[0]!.workspaceId).toBe('resolved-concrete-ws');
    } finally {
      if (prior === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
      else process.env.PAPERCUSP_WORKSPACE_ID = prior;
    }
  });
});

describe('deriveCarryQueryHandles — pull-precise handles, no recall (P-026 leg (a), WI-5001)', () => {
  it('emits a work-item handle per held item, titled by the item title', () => {
    const handles = deriveCarryQueryHandles({
      heldItems: [{ id: 'WI-42', title: 'wire the prelude' }],
      awaits: [],
      facts: [],
    });
    expect(handles).toEqual([{ kind: 'work-item', ref: 'WI-42', query: ['wire the prelude'] }]);
  });

  it('falls back to the id itself when a held item has no title', () => {
    const handles = deriveCarryQueryHandles({
      heldItems: [{ id: 'WI-42', title: null }],
      awaits: [],
      facts: [],
    });
    expect(handles).toEqual([{ kind: 'work-item', ref: 'WI-42', query: ['WI-42'] }]);
  });

  it('emits a topic handle per open await ("open thread"), titled by its note or else the event key', () => {
    const handles = deriveCarryQueryHandles({
      heldItems: [],
      awaits: [
        { eventKey: 'work-item:claimable', note: 'lane drained, waiting for new work' },
        { eventKey: 'deploy:done', note: null },
      ],
      facts: [],
    });
    expect(handles).toEqual([
      { kind: 'topic', ref: 'work-item:claimable', query: ['lane drained, waiting for new work'] },
      { kind: 'topic', ref: 'deploy:done', query: ['deploy:done'] },
    ]);
  });

  it('emits a fact handle ONLY for dead-end-keyed facts (dead-end:%), skipping ordinary standing facts', () => {
    const handles = deriveCarryQueryHandles({
      heldItems: [],
      awaits: [],
      facts: [
        { key: 'dead-end:tried-raw-sql-migration', body: '⛔ DEAD END: raw psql -f skips schema_migrations' },
        { key: 'wi-5003-blocked-not-a-bug', body: 'genuinely DAG-blocked, not a scheduler bug' },
      ],
    });
    expect(handles).toEqual([
      {
        kind: 'fact',
        ref: 'dead-end:tried-raw-sql-migration',
        query: ['⛔ DEAD END: raw psql -f skips schema_migrations'],
      },
    ]);
  });

  it('mixes all three classes in order: held-WI, then open threads, then dead-ends', () => {
    const handles = deriveCarryQueryHandles({
      heldItems: [{ id: 'WI-1', title: 'a' }],
      awaits: [{ eventKey: 'ev-1', note: 'b' }],
      facts: [{ key: 'dead-end:x', body: 'c' }],
    });
    expect(handles.map((h) => h.kind)).toEqual(['work-item', 'topic', 'fact']);
  });

  it('caps the OVERALL handle count at `max`, stopping mid-class rather than dropping a whole class', () => {
    const handles = deriveCarryQueryHandles(
      {
        heldItems: [
          { id: 'WI-1', title: 'a' },
          { id: 'WI-2', title: 'b' },
        ],
        awaits: [{ eventKey: 'ev-1', note: 'c' }],
        facts: [{ key: 'dead-end:x', body: 'd' }],
      },
      2,
    );
    expect(handles).toHaveLength(2);
    expect(handles.map((h) => h.ref)).toEqual(['WI-1', 'WI-2']);
  });

  it('defaults to CARRY_QUERY_HANDLES_MAX when no cap is passed', () => {
    const heldItems = Array.from({ length: CARRY_QUERY_HANDLES_MAX + 5 }, (_, i) => ({
      id: `WI-${i}`,
      title: `item ${i}`,
    }));
    const handles = deriveCarryQueryHandles({ heldItems, awaits: [], facts: [] });
    expect(handles).toHaveLength(CARRY_QUERY_HANDLES_MAX);
  });

  it('clamps an overlong query to 200 chars with an ellipsis', () => {
    const long = 'x'.repeat(300);
    const handles = deriveCarryQueryHandles({
      heldItems: [{ id: 'WI-1', title: long }],
      awaits: [],
      facts: [],
    });
    expect(handles[0]!.query[0]!.length).toBe(200);
    expect(handles[0]!.query[0]!.endsWith('…')).toBe(true);
  });

  it('empty input → empty handles', () => {
    expect(deriveCarryQueryHandles({ heldItems: [], awaits: [], facts: [] })).toEqual([]);
  });
});

describe('renderCarryQueryHandlesBlock — the deterministic pointer-list render', () => {
  it('null on an empty handles list (nothing to inject)', () => {
    expect(renderCarryQueryHandlesBlock([])).toBeNull();
  });

  it('renders one bracketed [kind:ref] line per handle under the fixed heading', () => {
    const out = renderCarryQueryHandlesBlock([
      { kind: 'work-item', ref: 'WI-42', query: ['wire the prelude'] },
      { kind: 'fact', ref: 'dead-end:x', query: ['tried raw SQL, broke migrations'] },
    ]);
    expect(out).toBe(
      `${CARRY_QUERY_HANDLES_HEADING}\n` +
        '- [work-item:WI-42] pull: wire the prelude\n' +
        '- [fact:dead-end:x] pull: tried raw SQL, broke migrations',
    );
  });

  it('joins a multi-term query with " | "', () => {
    const out = renderCarryQueryHandlesBlock([
      { kind: 'topic', ref: 'ev-1', query: ['term one', 'term two'] },
    ]);
    expect(out).toBe(`${CARRY_QUERY_HANDLES_HEADING}\n- [topic:ev-1] pull: term one | term two`);
  });
});
