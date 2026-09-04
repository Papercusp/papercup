/** Deterministic carry-document builder (deterministic-context-carry P-009):
 *  the seam-driven assembly (identity + session-mode + plan-state + asks + tail
 *  layered on the carry brief) and the pure full-document renderer. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { CarryBrief } from './carry-brief';
import type { AutomaticCompactionRecovery } from './agent-tools/coordination/compaction-recovery';
import {
  buildCarryDoc,
  renderCarryDoc,
  deriveContinuation,
  gateOpenOwnerQuestion,
  carryDocBudgetChars,
  CARRY_DOC_BUDGET_FRACTION,
  CARRY_DOC_SLOTS,
  CARRY_DOC_SHED_LADDER,
  SELF_RECALL_POINTER,
  REORIENT_BANNER,
  CARRY_DOC_MAX_TAIL_TURNS,
  CARRY_DOC_MAX_PLAN_ITEMS,
  flagAsksAgainstFacts,
  renderBuiltAtStamp,
  type CarryDoc,
  type CarryDocPlanItem,
  type CarryDocAsk,
  type CarryDocTailTurn,
  type CarryDocContinuation,
  type CarryDocSlotKind,
} from './carry-doc';

const NOW = 1_800_000_000_000;

function automaticRecovery(complete = true): AutomaticCompactionRecovery {
  return {
    marker: {
      schemaVersion: 'post-compaction-recovery-v1',
      complete,
      memoryEpoch: 23,
      controlGeneration: complete ? 17 : null,
      fallback: {
        verb: 'coord:orient',
        args: { afterCompaction: true },
        when: ['marker-absent', 'marker-incomplete', 'control-generation-mismatch'],
      },
    },
    recovery: {
      selfRecall: "sessions:search { session:'self', mode:'verbatim' }",
      loop: complete ? { active: true, intervalSec: 60 } : null,
      control: complete
        ? {
            schemaVersion: 'ctrl-v1',
            generation: 17,
            state: {
              modes: ['auto'],
              loop: { active: true, intervalSec: 60 },
              wakeSource: 'loop',
              carry: 'warm',
              route: { kind: 'self' },
              scope: {
                workspace: 'ws-1',
                harness: 'papercusp',
                plan: 'fleet-deltas-leader-primitives-2026-07-10',
                items: ['P-017'],
              },
            },
            provenance: {
              source: 'harness_shared.session_briefs.control_state',
              ownerId: 'su-1',
              updatedAt: '2026-08-25T00:00:00.000Z',
            },
            resync: {
              on: ['missing-base', 'schema-mismatch', 'generation-mismatch'],
              verb: 'coord:orient',
              args: { afterCompaction: true },
              rule: 'replace-full-never-merge-behind',
            },
            budget: { estimatedTokens: 100, maxTokens: 384 },
          }
        : null,
      checkpoints: [
        {
          id: 'WI-41558',
          harness: 'papercusp',
          title: 'automatic recovery',
          body: 'reuse the deterministic carry boundary',
          checkpoint: 'P-017 in progress',
        },
      ],
      coverage: {
        selfSession: true,
        control: complete,
        heldItems: true,
        staleness: null,
      },
    },
  };
}

function brief(over: Partial<CarryBrief> = {}): CarryBrief {
  return {
    ownerId: 'su-1',
    loop: { harness: 'papercusp', active: true, intervalSec: 60, goal: null, carryNote: '## Next\ngo', carryNoteUpdatedAtMs: NOW },
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
    ...over,
  };
}

describe('flagAsksAgainstFacts (WI-5682 — decided-directive-re-asked guard)', () => {
  it('flags an open ask that re-litigates a decided standing fact', () => {
    const asks: CarryDocAsk[] = [{
      id: 'conv-mrssq5xh',
      question:
        "Fleet-drain scope decision: 55 open bugs live under harness_slug='operator:papercusp-workspace' outside the papercusp drain lane — fold them in?",
      askedAtMs: NOW,
    }];
    const facts = [{
      key: 'work-item-pot-binding-integrity',
      body:
        'operator:papercusp-workspace is NOT a real pot; MOVE those work-items to the papercusp pot; 37 open bugs orphaned under harness_slug.',
    }];
    const [flagged] = flagAsksAgainstFacts(asks, facts);
    expect(flagged.possiblyDecidedBy).toEqual(['work-item-pot-binding-integrity']);
  });

  it('does NOT flag a genuinely unrelated open question', () => {
    const asks: CarryDocAsk[] = [{
      id: 'conv-x',
      question: 'Should we bump the gateway timeout for the nightly bench run?',
      askedAtMs: NOW,
    }];
    const facts = [{
      key: 'work-item-pot-binding-integrity',
      body: 'operator:papercusp-workspace is not a real pot; move work-items to the papercusp pot.',
    }];
    expect(flagAsksAgainstFacts(asks, facts)[0].possiblyDecidedBy).toBeUndefined();
  });

  it('is a no-op with no facts (never invents a collision)', () => {
    const asks: CarryDocAsk[] = [{ id: 'c', question: 'anything at all in here', askedAtMs: null }];
    expect(flagAsksAgainstFacts(asks, [])).toEqual(asks);
  });
});

describe('buildCarryDoc (seam-driven assembly)', () => {
  const base = {
    workspaceId: 'ws-1',
    harness: 'papercusp',
    ownerLabel: 'su · su-1',
    buildCarryBriefFn: async () => brief(),
    buildAutomaticRecoveryFn: async () => automaticRecovery(),
    getModesFn: async () => [{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }],
  };

  it('assembles identity + session-mode from the brief + seams', async () => {
    const doc = await buildCarryDoc('su-1', base);
    expect(doc.identity).toMatchObject({ ownerId: 'su-1', harness: 'papercusp', workspaceId: 'ws-1', ownerLabel: 'su · su-1' });
    expect(doc.sessionMode.loopActive).toBe(true);
    expect(doc.sessionMode.loopIntervalSec).toBe(60);
    expect(doc.sessionMode.modes).toEqual([{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }]);
  });

  it('builds one automatic recovery from the already-read carry held-items snapshot', async () => {
    const heldItems = [
      {
        id: 'WI-41558',
        title: 'automatic recovery',
        body: 'reuse the deterministic carry boundary',
        harness: 'papercusp',
        checkpoint: 'P-017 in progress',
        checkpointUpdatedAtMs: NOW,
      },
    ];
    const buildAutomaticRecoveryFn = vi.fn(async () => automaticRecovery());
    const built = await buildCarryDoc('su-1', {
      ...base,
      buildCarryBriefFn: async () => brief({ heldItems }),
      buildAutomaticRecoveryFn,
    });

    expect(buildAutomaticRecoveryFn).toHaveBeenCalledOnce();
    expect(buildAutomaticRecoveryFn).toHaveBeenCalledWith('su-1', 'ws-1', {
      sessionHarness: 'papercusp',
      heldItems,
    });
    expect(built.automaticRecovery).toEqual(automaticRecovery());
  });

  it('does not infer caller/session scope from a different persisted loop harness', async () => {
    const buildAutomaticRecoveryFn = vi.fn(async () => automaticRecovery());
    const { harness: _callerHarness, ...baseWithoutHarness } = base;
    const built = await buildCarryDoc('su-1', {
      ...baseWithoutHarness,
      buildCarryBriefFn: async () =>
        brief({
          loop: {
            harness: 'persisted-loop-scope',
            active: true,
            intervalSec: 60,
            goal: null,
            carryNote: '## Next\ngo',
            carryNoteUpdatedAtMs: NOW,
          },
        }),
      buildAutomaticRecoveryFn,
    });

    expect(buildAutomaticRecoveryFn).toHaveBeenCalledWith('su-1', 'ws-1', {
      sessionHarness: null,
      heldItems: [],
    });
    expect(built.identity.harness).toBeNull();
  });

  /**
   * EI-20072281215342526 — the carry document printed the loop's INTERVAL and not its
   * GOAL, so a respawned successor was told a loop existed but not what it was FOR.
   * That asymmetry is the bug: the successor inherits its held work-items without the
   * mission that generated them, and does not halt — it re-orients, sees unclaimed
   * backlog, and confidently starts something else.
   */
  describe('the loop GOAL is carried — the mission, not just the cadence', () => {
    const withGoal = (goal: string | null) => ({
      ...base,
      buildCarryBriefFn: async () =>
        brief({
          loop: { harness: 'papercusp', active: true, intervalSec: 60, goal, carryNote: '## Next\ngo', carryNoteUpdatedAtMs: NOW },
        }),
    });

    it('carries the goal onto sessionMode and renders it VERBATIM', async () => {
      const mission = 'Drive plan retire-mug-kettle-su-only-2026-08-09 (harness papercusp) to completion.';
      const doc = await buildCarryDoc('su-1', withGoal(mission));
      expect(doc.sessionMode.loopGoal).toBe(mission);
      const text = renderCarryDoc(doc, NOW);
      // Verbatim, not summarised: the successor's whole problem is that it holds no
      // other copy of this text.
      expect(text).toContain(mission);
      expect(text).toContain('YOUR MISSION');
      // It must still say the goal is frozen — carrying it more prominently without
      // that caveat would just move the staleness problem into the carry document.
      expect(text).toMatch(/frozen at arm time/);
    });

    it('renders NO mission line when the loop has no goal — never a blank one', async () => {
      const doc = await buildCarryDoc('su-1', withGoal(null));
      expect(doc.sessionMode.loopGoal).toBeNull();
      const text = renderCarryDoc(doc, NOW);
      expect(text).not.toContain('YOUR MISSION');
      // The loop line itself is untouched.
      expect(text).toContain('loop: ARMED (every 60s)');
    });
  });

  it('a throwing brief build degrades to an empty brief, never throws', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      buildCarryBriefFn: async () => {
        throw new Error('db down');
      },
    });
    expect(doc.brief.heldItems).toEqual([]);
    expect(doc.sessionMode.loopActive).toBe(false);
  });

  it('a throwing mode seam yields no modes, never a failed document', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      getModesFn: async () => {
        throw new Error('modes down');
      },
    });
    expect(doc.sessionMode.modes).toEqual([]);
  });

  it('caps the tail to the most-recent N turns', async () => {
    const turns: CarryDocTailTurn[] = Array.from({ length: CARRY_DOC_MAX_TAIL_TURNS + 4 }, (_, i) => ({
      speaker: 'assistant',
      text: `turn ${i}`,
      ts: null,
    }));
    const doc = await buildCarryDoc('su-1', { ...base, getTailFn: async () => turns });
    expect(doc.tail).toHaveLength(CARRY_DOC_MAX_TAIL_TURNS);
    expect(doc.tail[doc.tail.length - 1].text).toBe(`turn ${CARRY_DOC_MAX_TAIL_TURNS + 3}`);
  });

  it('the plan-state seam flows through and is capped to the max', async () => {
    const many: CarryDocPlanItem[] = Array.from({ length: CARRY_DOC_MAX_PLAN_ITEMS + 3 }, (_, i) => ({
      itemId: `P-${i}`,
      planSlug: 'plan-x',
      status: 'wip',
      disposition: 'active',
    }));
    const doc = await buildCarryDoc('su-1', { ...base, getPlanItemsFn: async () => many });
    expect(doc.planItems).toHaveLength(CARRY_DOC_MAX_PLAN_ITEMS);
    expect(doc.planItems[0]).toMatchObject({ itemId: 'P-0', planSlug: 'plan-x', disposition: 'active' });
  });

  it('the asks seam surfaces only the caller-asked open questions', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      getPlanItemsFn: async () => [],
      getAsksFn: async () => [
        { id: 'c1', question: 'which backend?', askedAtMs: NOW },
        { id: 'c2', question: 'ship gate?', askedAtMs: null },
      ],
    });
    expect(doc.asks.map((a) => a.id)).toEqual(['c1', 'c2']);
  });

  it('asks / tail degrade to empty when the readers find nothing / no transcript', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      getPlanItemsFn: async () => [],
      getAsksFn: async () => [],
    });
    expect(doc.asks).toEqual([]);
    expect(doc.tail).toEqual([]);
  });

  it('the real tail leg reads a transcript file and MECHANICALLY stamps user turns (D-003)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-carry-doc-test-'));
    try {
      const f = join(dir, 'sess.jsonl');
      const line = (role: 'user' | 'assistant', text: string, ts: string) =>
        JSON.stringify({ type: role, timestamp: ts, sessionId: 's', message: { role, content: [{ type: 'text', text }] } });
      writeFileSync(
        f,
        [
          line('user', 'ship the carry doc', '2026-07-14T10:00:00Z'),
          line('assistant', 'wiring the tail reader', '2026-07-14T10:00:05Z'),
          line('user', '⟦turn-origin:wake-pump nonce:6b5c8079e022af6b⟧ loop wake — continue', '2026-07-14T10:01:00Z'),
        ].join('\n') + '\n',
      );
      const doc = await buildCarryDoc('su-1', { ...base, getPlanItemsFn: async () => [], transcriptPath: f });
      expect(doc.tail.map((t) => t.text)).toEqual([
        'ship the carry doc',
        'wiring the tail reader',
        '⟦turn-origin:wake-pump nonce:6b5c8079e022af6b⟧ loop wake — continue',
      ]);
      expect(doc.tail[0].ts).toBe('2026-07-14T10:00:00.000Z');
      // The stamp is decided by the recorded envelope, not the prose: no
      // envelope → owner-typed; an envelope → agent-injected with its origin.
      expect(doc.tail[0].provenance).toEqual({ verdict: 'owner-typed', origin: null });
      expect(doc.tail[1].provenance).toBeNull(); // assistant turns carry none
      expect(doc.tail[2].provenance).toEqual({ verdict: 'agent-injected', origin: 'wake-pump' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderBuiltAtStamp (EI-18697157970421032, pure)', () => {
  it('renders the exact ISO build time and a concrete staleness window', () => {
    const stamp = renderBuiltAtStamp(NOW);
    expect(stamp).toContain(new Date(NOW).toISOString());
    expect(stamp).toContain('Carry document built at');
    expect(stamp).toMatch(/30 minutes/);
  });

  it('is deterministic (same input, same output)', () => {
    expect(renderBuiltAtStamp(NOW)).toBe(renderBuiltAtStamp(NOW));
    expect(renderBuiltAtStamp(NOW)).not.toBe(renderBuiltAtStamp(NOW + 1));
  });

  it('warns about the build-to-death blind window (EI-18894888815338094)', () => {
    // A successor's own pre-respawn session can keep doing real, durable work
    // (finishing an experiment, writing an artifact) AFTER this stamp but before
    // it actually dies — none of that is reflected in an already-frozen document.
    // The stamp must tell the reader this document is a LOWER BOUND, not a
    // complete record, and to check the filesystem/work-item before redoing work.
    const stamp = renderBuiltAtStamp(NOW);
    expect(stamp).toMatch(/BLIND WINDOW/);
    expect(stamp).toContain('may have kept working');
    expect(stamp).toMatch(/check the filesystem/);
  });

  it('warns that a RETRACTED CLAIM can ride the same blind window (EI-19340500312449463)', () => {
    // A pre-respawn session can report a finding, catch it overstated the
    // claim, and retract it (coord:send correction / work-item comment /
    // loop:checkpoint) — all AFTER this document was assembled but before it
    // actually died. Without an explicit warning, a successor reads the
    // already-frozen (and since-withdrawn) claim as this system-injected
    // document's own framing — MORE apparent authority than the peer-authored
    // correction it superseded. The stamp must name this explicitly (not just
    // "artifacts/experiments") and point at coord:feed / the work-item's
    // comments as the authority instead.
    const stamp = renderBuiltAtStamp(NOW);
    expect(stamp).toMatch(/RETRACTED CLAIMS/);
    expect(stamp).toContain('coord:feed');
    expect(stamp).toMatch(/more apparent authority/i);
  });
});

describe('renderCarryDoc (pure)', () => {
  const planItems: CarryDocPlanItem[] = [
    { itemId: 'P-009', planSlug: 'deterministic-context-carry-2026-07-14', status: 'wip', disposition: 'claimed' },
  ];
  const asks: CarryDocAsk[] = [{ id: '7', question: 'Which backend for the sweep?', askedAtMs: NOW }];
  const tail: CarryDocTailTurn[] = [
    { speaker: 'owner', text: 'ship it', ts: '2026-07-14T10:00:00Z' },
    { speaker: 'assistant', text: 'on it', ts: '2026-07-14T10:00:05Z' },
  ];

  function doc(over: Partial<CarryDoc> = {}): CarryDoc {
    return {
      brief: brief(),
      identity: { ownerId: 'su-1', ownerLabel: 'su · su-1', harness: 'papercusp', workspaceId: 'ws-1', fleet: { slug: 'f1', role: 'leader' }, account: 'default' },
      sessionMode: { modes: [{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }], loopActive: true, loopIntervalSec: 60 },
      planItems,
      asks,
      tail,
      continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true },
      ...over,
    };
  }

  it('renders a complete generation-stamped recovery as already delivered, with declare-intent as the next call', () => {
    const text = renderCarryDoc(doc({ automaticRecovery: automaticRecovery() }), NOW);
    expect(text).toContain('⟦post-compaction-recovery⟧');
    expect(text).toContain('"schemaVersion":"post-compaction-recovery-v1"');
    expect(text).toContain('"memoryEpoch":23');
    expect(text).toContain('"controlGeneration":17');
    expect(text).toContain('Do NOT call coord:orient');
    expect(text).toContain('coord:declare-intent { intent, current_plan_slug, items }');
    expect(text).not.toContain('planItems');
    expect(text).toContain('control generation 17');
  });

  it('renders exactly one orient fallback instruction when the marker is absent or incomplete', () => {
    for (const automatic of [undefined, automaticRecovery(false)]) {
      const text = renderCarryDoc(doc({ automaticRecovery: automatic }), NOW);
      expect(text.match(/Call `coord:orient \{ afterCompaction: true \}` exactly once/g)).toHaveLength(1);
      expect(text).not.toContain('Do NOT call coord:orient');
    }
  });

  it('renders every section in priority order with the banner + self-recall', () => {
    const text = renderCarryDoc(doc(), NOW);
    expect(text).toContain('# Carry document (deterministic');
    expect(text).toContain(REORIENT_BANNER);
    expect(text).toContain(renderBuiltAtStamp(NOW));
    expect(text.indexOf(REORIENT_BANNER)).toBeLessThan(text.indexOf(renderBuiltAtStamp(NOW)));
    expect(text.indexOf(renderBuiltAtStamp(NOW))).toBeLessThan(text.indexOf('## Identity'));
    expect(text).toContain('## Identity');
    expect(text).toContain('su-id: su-1 (su · su-1)');
    expect(text).toContain('fleet: f1 (leader)');
    expect(text).toContain('## Session mode');
    expect(text).toContain('AUTO: on (owner-directed)');
    expect(text).toContain('loop: ARMED (every 60s)');
    expect(text).toContain('## Standing carry');
    expect(text).toContain('P-009 [wip] deterministic-context-carry-2026-07-14 (claimed)');
    expect(text).toContain('## Open owner asks');
    expect(text).toContain('Which backend for the sweep?');
    expect(text).toContain('## Verbatim tail');
    expect(text).toContain('### OWNER @2026-07-14T10:00:00Z');
    expect(text).toContain('ship it');
    expect(text).toContain('## Self-recall');
    expect(text).toContain(SELF_RECALL_POINTER);
    // Order: identity precedes session mode precedes standing carry precedes tail.
    expect(text.indexOf('## Identity')).toBeLessThan(text.indexOf('## Session mode'));
    expect(text.indexOf('## Session mode')).toBeLessThan(text.indexOf('## Standing carry'));
    expect(text.indexOf('## Verbatim tail')).toBeLessThan(text.indexOf('## Self-recall'));
  });

  it('EI-18684357744098956: a held checkpoint written well before the latest tail turn renders SUPERSEDED', () => {
    // The verified incident's shape: a checkpoint written, then real session
    // activity continued past it (here, the tail's latest turn is 10 minutes
    // later) without the checkpoint being refreshed — the carry doc must not
    // hand that stale claim over with the same authority as a current one.
    const checkpointUpdatedAtMs = Date.parse('2026-07-14T09:50:00Z');
    const text = renderCarryDoc(
      doc({
        brief: brief({
          heldItems: [
            {
              id: 'WI-5943',
              title: 'hyperdht instrumentation',
              body: null,
              harness: 'papercusp',
              checkpoint: 'ZERO CODE HAS BEEN WRITTEN. No file is edited. Nothing is half-done.',
              checkpointUpdatedAtMs,
            },
          ],
        }),
        // tail's latest turn is 2026-07-14T10:00:05Z — 10m+ after the checkpoint.
      }),
      NOW,
    );
    expect(text).toContain('⚠ SUPERSEDED');
    expect(text).toContain('ZERO CODE HAS BEEN WRITTEN'); // never dropped, just flagged
  });

  it('a checkpoint written AT/after the latest tail turn renders as plain fact (not superseded)', () => {
    const checkpointUpdatedAtMs = Date.parse('2026-07-14T10:00:04Z'); // 1s before the last turn
    const text = renderCarryDoc(
      doc({
        brief: brief({
          heldItems: [
            { id: 'WI-1', title: null, body: null, harness: 'papercusp', checkpoint: 'landed and verified', checkpointUpdatedAtMs },
          ],
        }),
      }),
      NOW,
    );
    expect(text).not.toContain('SUPERSEDED');
    expect(text).toContain('checkpoint: landed and verified');
  });

  it('omits empty optional sections but always keeps banner/identity/mode/self-recall', () => {
    const text = renderCarryDoc(doc({ planItems: [], asks: [], tail: [] }), NOW);
    expect(text).not.toContain('## Plan state');
    expect(text).not.toContain('## Open owner asks');
    expect(text).not.toContain('## Verbatim tail');
    expect(text).toContain('## Identity');
    expect(text).toContain('## Session mode');
    expect(text).toContain('## Self-recall');
  });

  it('a not-armed loop renders the halt warning', () => {
    const text = renderCarryDoc(doc({ sessionMode: { modes: [], loopActive: false, loopIntervalSec: null } }), NOW);
    expect(text).toContain('loop: not armed');
    expect(text).toContain('- no active modes');
  });

  // WI-6949 — AUTO with no loop is an ALARM, not a neutral fact. The prior wording buried
  // the consequence behind an "unless an owner is present" get-out, which a successor
  // reading it WITH an owner present correctly resolved to "fine" — and then inherited the
  // halt when the owner left. These pin that the two cases read differently.
  describe('the AUTO × no-loop combination escalates', () => {
    const render = (
      modes: { mode: string; ownerDirected: boolean; reason: string }[],
      loopActive: boolean,
      awaits: CarryBrief['awaits'] = [],
    ) =>
      renderCarryDoc(
        doc({
          brief: brief({ awaits }),
          sessionMode: { modes, loopActive, loopIntervalSec: loopActive ? 60 : null },
        }),
        NOW,
      );

    it('shouts when an autonomy mode is on and no loop is armed', () => {
      const text = render([{ mode: 'auto', ownerDirected: true, reason: 'owner said keep going' }], false);
      expect(text).toContain('NOT ARMED, AND AN AUTONOMY MODE IS ON');
      expect(text).toContain('HALTS');
      expect(text).toContain('loop:arm');
    });

    it('escalates for cold-auto and drain too, not just auto', () => {
      for (const mode of ['cold-auto', 'drain']) {
        expect(render([{ mode, ownerDirected: true, reason: 'r' }], false)).toContain('NOT ARMED, AND AN AUTONOMY MODE IS ON');
      }
    });

    it('does NOT escalate for a non-autonomy mode alone (ideate)', () => {
      const text = render([{ mode: 'ideate', ownerDirected: true, reason: 'r' }], false);
      expect(text).not.toContain('AN AUTONOMY MODE IS ON');
      expect(text).toContain('loop: not armed');
    });

    it('does NOT escalate when the loop IS armed, however autonomous the mode', () => {
      const text = render([{ mode: 'auto', ownerDirected: true, reason: 'r' }], true);
      expect(text).not.toContain('NOT ARMED');
      expect(text).toContain('loop: ARMED');
    });

    it('does NOT claim there is NO wake source when a live await is carried', () => {
      const text = render(
        [{ mode: 'auto', ownerDirected: true, reason: 'owner said keep going' }],
        false,
        [{ eventKey: 'work-item:claimable', note: 'lane refilled' }],
      );
      expect(text).toContain('LIVE EVENT AWAITS PROVIDE A WAKE SOURCE RIGHT NOW');
      expect(text).toContain('Your armed awaits are still live and WILL wake you');
      expect(text).not.toContain('You have NO wake source');
    });

    it('even the no-modes line names the owner as a wake source that can disappear', () => {
      const text = render([], false);
      expect(text).toMatch(/only wake source is the owner speaking/i);
    });
  });

  it('the mechanical stamp OUTRANKS the speaker in tail headers (WI-3532 class)', () => {
    const text = renderCarryDoc(
      doc({
        tail: [
          { speaker: 'user', text: 'ship it', ts: null, provenance: { verdict: 'owner-typed', origin: null } },
          { speaker: 'user', text: 'use route B', ts: null, provenance: { verdict: 'owner-dialog', origin: null } },
          { speaker: 'user', text: 'loop wake', ts: null, provenance: { verdict: 'agent-injected', origin: 'wake-pump' } },
          { speaker: 'user', text: '/compact ran', ts: null, provenance: { verdict: 'synthetic', origin: null } },
          { speaker: 'user', text: 'no ledger era', ts: null },
        ],
      }),
      NOW,
    );
    expect(text).toContain('### OWNER (typed — mechanically classified)');
    expect(text).toContain('### OWNER (dialog answer — mechanically classified)');
    expect(text).toContain('### machine-injected (wake-pump) — NOT the owner');
    expect(text).toContain('### machine (harness-synthetic) — NOT the owner');
    expect(text).toContain('### user (unclassified)');
  });

  it('an OPEN owner message renders as the first prompt and is NOT quoted in the tail (P-010)', () => {
    const text = renderCarryDoc(
      doc({
        tail: [
          { speaker: 'assistant', text: 'earlier work', ts: null },
          { speaker: 'user', text: 'now fix the migration', ts: null, provenance: { verdict: 'owner-typed', origin: null } },
        ],
        continuation: { lastOwnerMessage: { text: 'now fix the migration', ts: null }, answered: false, deliberate: true, selfRequested: true },
      }),
      NOW,
    );
    expect(text).toContain('## Continuation (last-turn handling)');
    expect(text).toContain('Boundary: DELIBERATE');
    expect(text).toContain('OPEN (unanswered)');
    expect(text).toContain('ACTUAL FIRST');
    expect(text).toContain('Preview: «now fix the migration»');
    // "never quoted material": the open owner turn is delivered live, not quoted.
    expect(text).not.toContain('### OWNER (typed — mechanically classified)');
    expect(text).toContain('### you'); // the assistant history turn still shows
  });

  it('an ANSWERED owner message stays quoted in the tail and a FORCED boundary is flagged', () => {
    const text = renderCarryDoc(
      doc({
        tail: [
          { speaker: 'user', text: 'ship it', ts: null, provenance: { verdict: 'owner-typed', origin: null } },
          { speaker: 'assistant', text: 'shipped', ts: null },
        ],
        continuation: { lastOwnerMessage: { text: 'ship it', ts: null }, answered: true, deliberate: false, selfRequested: false },
      }),
      NOW,
    );
    expect(text).toContain('Boundary: FORCED');
    expect(text).toContain('ANSWERED before this boundary');
    expect(text).toContain('### OWNER (typed — mechanically classified)'); // still quoted as history
  });

  it('no owner turn in the tail renders the standing-work continuation line', () => {
    const text = renderCarryDoc(doc({ tail: [], continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true } }), NOW);
    expect(text).toContain('No owner turn in the recent tail');
  });

  it('a CLEAN watchdog-initiated boundary never claims the session flushed (2026-07-18 provenance mislabel)', () => {
    const text = renderCarryDoc(
      doc({ tail: [], continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: false } }),
      NOW,
    );
    expect(text).toContain('Boundary: CLEAN but WATCHDOG-INITIATED');
    expect(text).toContain('did NOT request this cut');
    expect(text).not.toContain('state was flushed');
    expect(text).not.toContain('Boundary: DELIBERATE');
  });
});

describe('deriveContinuation (pure, P-010)', () => {
  const ownerTurn = (text: string): CarryDocTailTurn => ({ speaker: 'user', text, ts: null, provenance: { verdict: 'owner-typed', origin: null } });
  const ownerDialog = (text: string): CarryDocTailTurn => ({ speaker: 'user', text, ts: null, provenance: { verdict: 'owner-dialog', origin: null } });
  const wake = (text: string): CarryDocTailTurn => ({ speaker: 'user', text, ts: null, provenance: { verdict: 'agent-injected', origin: 'wake-pump' } });
  const model = (text: string): CarryDocTailTurn => ({ speaker: 'assistant', text, ts: null });

  it('identifies the final OWNER-typed turn — not a later agent-injected user turn (WI-3532 class)', () => {
    const cont = deriveContinuation([ownerTurn('do the thing'), model('on it'), wake('loop wake — continue')], true);
    expect(cont.lastOwnerMessage?.text).toBe('do the thing');
  });

  it('treats an AskUserQuestion dialog answer as owner speech across the boundary', () => {
    const cont = deriveContinuation([ownerTurn('earlier'), model('asked'), ownerDialog('use route B')], true);
    expect(cont.lastOwnerMessage?.text).toBe('use route B');
    expect(cont.answered).toBe(false);
  });

  it('answered=true when a model turn follows the owner message; false when it is the last real turn', () => {
    expect(deriveContinuation([ownerTurn('q'), model('a')], true).answered).toBe(true);
    // A machine wake after the owner message does NOT answer it.
    expect(deriveContinuation([ownerTurn('q'), wake('w')], true).answered).toBe(false);
  });

  it('no owner turn ⇒ null message, vacuously answered, boundary flag flows through', () => {
    const cont = deriveContinuation([model('a'), wake('w')], false);
    expect(cont).toEqual({ lastOwnerMessage: null, answered: true, deliberate: false, selfRequested: false });
  });

  it('selfRequested defaults to the deliberate flag (historical meaning preserved) and can be overridden false', () => {
    expect(deriveContinuation([model('a')], true).selfRequested).toBe(true);
    expect(deriveContinuation([model('a')], true, false).selfRequested).toBe(false);
    // Invariant: a forced boundary can never read as self-requested.
    expect(deriveContinuation([model('a')], false, true).selfRequested).toBe(false);
  });

  it('picks the LAST owner turn when several are present', () => {
    const cont = deriveContinuation([ownerTurn('first'), model('a'), ownerTurn('second')], true);
    expect(cont.lastOwnerMessage?.text).toBe('second');
    expect(cont.answered).toBe(false);
  });
});

describe('gateOpenOwnerQuestion (pure, P-010)', () => {
  const open: CarryDocContinuation = { lastOwnerMessage: { text: 'answer me', ts: null }, answered: false, deliberate: true, selfRequested: true };

  it('trips only on a DELIBERATE boundary across an UNANSWERED owner message', () => {
    const gate = gateOpenOwnerQuestion(open);
    expect(gate.crossesOpenOwnerMessage).toBe(true);
    expect(gate.refusalText).toContain('UNANSWERED');
    expect(gate.refusalText).toContain('first prompt');
  });

  it('does NOT trip on a forced boundary, an answered message, or no owner message', () => {
    expect(gateOpenOwnerQuestion({ ...open, deliberate: false }).crossesOpenOwnerMessage).toBe(false);
    expect(gateOpenOwnerQuestion({ ...open, answered: true }).crossesOpenOwnerMessage).toBe(false);
    expect(gateOpenOwnerQuestion({ lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true }).crossesOpenOwnerMessage).toBe(false);
  });
});

describe('buildCarryDoc continuation leg (P-010)', () => {
  const base = {
    workspaceId: 'ws-1',
    harness: 'papercusp',
    ownerLabel: 'su · su-1',
    buildCarryBriefFn: async () => brief(),
    getModesFn: async () => [] as { mode: string; ownerDirected: boolean; reason: string | null }[],
    getPlanItemsFn: async () => [] as CarryDocPlanItem[],
    getAsksFn: async () => [] as CarryDocAsk[],
  };

  it('derives the continuation from the tail + boundaryDeliberate opt', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      boundaryDeliberate: true,
      getTailFn: async () => [
        { speaker: 'assistant', text: 'prior', ts: null } as CarryDocTailTurn,
        { speaker: 'user', text: 'open question', ts: null, provenance: { verdict: 'owner-typed', origin: null } } as CarryDocTailTurn,
      ],
    });
    expect(doc.continuation).toEqual({ lastOwnerMessage: { text: 'open question', ts: null }, answered: false, deliberate: true, selfRequested: true });
    expect(gateOpenOwnerQuestion(doc.continuation).crossesOpenOwnerMessage).toBe(true);
  });

  it('defaults boundaryDeliberate to false (forced/unknown — the safe under-promise)', async () => {
    const doc = await buildCarryDoc('su-1', { ...base, getTailFn: async () => [] });
    expect(doc.continuation.deliberate).toBe(false);
  });
});

describe('constant budget B + slot audit (P-011)', () => {
  it('budget is a constant fraction of the window, invariant in N (floored at one tail)', () => {
    expect(CARRY_DOC_BUDGET_FRACTION).toBe(0.1);
    // 10% of the window × 4 chars/token.
    expect(carryDocBudgetChars(200_000)).toBe(80_000);
    // Floor = one coherent verbatim tail (CARRY_DOC_MAX_TAIL_TURNS × 4000).
    const floor = CARRY_DOC_MAX_TAIL_TURNS * 4000;
    expect(carryDocBudgetChars(80_000)).toBe(floor); // exactly at the floor
    expect(carryDocBudgetChars(10_000)).toBe(floor); // floor binds
    expect(carryDocBudgetChars(0)).toBe(floor);
    expect(carryDocBudgetChars(Number.NaN)).toBe(floor);
    // Invariant in N: the budget is a pure function of the window — no turn/hop input.
    expect(carryDocBudgetChars(200_000)).toBe(carryDocBudgetChars(200_000));
  });

  it('every carry slot maps to a bounded kind — none append-only-in-context', () => {
    const admissible = new Set<CarryDocSlotKind>(['snapshot', 'sliding-window', 'top-k', 'derived']);
    for (const s of CARRY_DOC_SLOTS) expect(admissible.has(s.kind)).toBe(true);
    const slots = new Set(CARRY_DOC_SLOTS.map((s) => s.slot));
    for (const req of ['identity', 'sessionMode', 'planItems', 'asks', 'tail', 'continuation', 'brief']) {
      expect(slots.has(req)).toBe(true);
    }
    // The shed ladder sheds the re-injectable brief first, the blocking asks last.
    expect([...CARRY_DOC_SHED_LADDER]).toEqual(['brief', 'tail', 'planState', 'asks']);
  });
});

describe('aging ladder / budget fit (P-011)', () => {
  const cont: CarryDocContinuation = { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true };
  function fitDoc(over: Partial<CarryDoc> = {}): CarryDoc {
    return {
      brief: brief(),
      identity: { ownerId: 'su-1', ownerLabel: 'su · su-1', harness: 'papercusp', workspaceId: 'ws-1', fleet: null, account: 'default' },
      sessionMode: { modes: [{ mode: 'auto', ownerDirected: true, reason: 'r' }], loopActive: true, loopIntervalSec: 60 },
      planItems: [{ itemId: 'P-1', planSlug: 'plan-x', status: 'wip', disposition: 'claimed' }],
      asks: [{ id: '1', question: 'which backend?', askedAtMs: NOW }],
      tail: [{ speaker: 'assistant', text: 'recent work', ts: null }],
      continuation: cont,
      ...over,
    };
  }

  it('no budget (or a budget above the full render) returns the full document unchanged', () => {
    const doc = fitDoc();
    const full = renderCarryDoc(doc, NOW);
    expect(renderCarryDoc(doc, NOW, {})).toBe(full);
    expect(renderCarryDoc(doc, NOW, { budgetChars: full.length })).toBe(full);
    expect(renderCarryDoc(doc, NOW, { budgetChars: full.length + 5000 })).toBe(full);
  });

  it('over budget: the standing brief sheds FIRST to a pointer; always-keep sections survive; result fits B', () => {
    // A huge verbatim carry-note makes the brief the largest sheddable slot.
    const bigNote = '## Next\n' + 'X'.repeat(50_000);
    const doc = fitDoc({ brief: brief({ loop: { harness: 'papercusp', active: true, intervalSec: 60, goal: null, carryNote: bigNote, carryNoteUpdatedAtMs: NOW } }) });
    const B = 40_000;
    const out = renderCarryDoc(doc, NOW, { budgetChars: B });
    expect(out.length).toBeLessThanOrEqual(B);
    // brief dropped to its pointer (still headed), everything else survived.
    expect(out).toContain('## Standing carry');
    expect(out).toContain('dropped to fit the carry budget');
    expect(out).not.toContain('X'.repeat(200));
    expect(out).toContain('## Identity');
    expect(out).toContain('## Session mode');
    expect(out).toContain('## Continuation (last-turn handling)');
    expect(out).toContain('## Self-recall');
    expect(out).toContain('recent work'); // the small tail survived
  });

  it('the tail AGES oldest-turn-first when the budget is too tight for all of it', () => {
    const turn = (n: number) => ({ speaker: 'assistant' as const, text: `T${n}:` + 'y'.repeat(3900), ts: null });
    const doc = fitDoc({ tail: [turn(1), turn(2), turn(3), turn(4)] });
    // Budget large enough for the always-keep + small slots + ~2 turns, not all 4.
    const out = renderCarryDoc(doc, NOW, { budgetChars: 12_000 });
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).toContain('T4:'); // newest kept
    expect(out).not.toContain('T1:'); // oldest aged out
    expect(out).toContain('## Self-recall'); // always-keep survives
  });

  it('a tiny budget still emits the minimum viable orientation (never below the floor sections)', () => {
    const out = renderCarryDoc(fitDoc(), NOW, { budgetChars: 1 });
    expect(out).toContain('## Identity');
    expect(out).toContain('## Session mode');
    expect(out).toContain('## Self-recall');
    expect(out).toContain('## Continuation (last-turn handling)');
  });
});
