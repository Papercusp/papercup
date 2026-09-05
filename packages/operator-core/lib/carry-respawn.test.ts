/** carry-respawn (deterministic-context-carry P-018 deterministic core): the pure
 *  producer→consumer bridge that turns a built CarryDoc into a respawn launch spec
 *  — the renderCarryDoc({budgetChars}) handoff + the open-owner-message first
 *  prompt (P-010) + the open-owner-question boundary gate. */
import { describe, it, expect } from 'vitest';
import type { CarryBrief } from './carry-brief';
import {
  renderCarryDoc,
  carryDocBudgetChars,
  gateOpenOwnerQuestion,
  type BuildCarryDocOpts,
  type CarryDoc,
  type CarryDocContinuation,
} from './carry-doc';
import {
  buildOwnerRespawnLaunchSpec,
  buildRespawnLaunchSpec,
  deriveRespawnFirstPrompt,
} from './carry-respawn';

const NOW = 1_800_000_000_000;

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

function doc(continuation: CarryDocContinuation, over: Partial<CarryDoc> = {}): CarryDoc {
  return {
    brief: brief(),
    identity: {
      ownerId: 'su-1',
      ownerLabel: 'su · su-1',
      harness: 'papercusp',
      workspaceId: 'ws-1',
      fleet: null,
      account: null,
    },
    sessionMode: { modes: [{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }], loopActive: true, loopIntervalSec: 60 },
    planItems: [],
    asks: [],
    tail: [],
    continuation,
    ...over,
  };
}

const OPEN_DELIBERATE: CarryDocContinuation = {
  lastOwnerMessage: { text: 'ship the release when the gate is green', ts: '2026-07-14T20:00:00.000Z' },
  answered: false,
  deliberate: true,
  selfRequested: true,
};
const OPEN_FORCED: CarryDocContinuation = { ...OPEN_DELIBERATE, deliberate: false };
const ANSWERED: CarryDocContinuation = { ...OPEN_DELIBERATE, answered: true };
const NO_OWNER: CarryDocContinuation = { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true };

describe('buildRespawnLaunchSpec — assembly', () => {
  it('renders the carry doc to the budget-B addendum and derives the budget from the window', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(NO_OWNER), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.budgetChars).toBe(carryDocBudgetChars(400_000));
    // The addendum IS renderCarryDoc held to that exact budget — wired through, not re-implemented.
    expect(spec.systemPromptAddendum).toBe(renderCarryDoc(doc(NO_OWNER), NOW, { budgetChars: spec.budgetChars }));
    // It carries the minimum-viable orientation (banner + identity + self-recall).
    expect(spec.systemPromptAddendum).toContain('Carry document (deterministic');
    expect(spec.systemPromptAddendum).toContain('su · su-1');
    expect(spec.systemPromptAddendum).toContain('Self-recall');
  });

  it('carries same-session retracted continuation refs into the launch spec', () => {
    const spec = buildRespawnLaunchSpec({
      doc: doc(NO_OWNER, { retractedContinuationRefs: ['EI-20191442676357637'] }),
      effectiveWindowTokens: 400_000,
      now: NOW,
    });
    expect(spec.retractedContinuationRefs).toEqual(['EI-20191442676357637']);
    expect(spec.systemPromptAddendum).toContain('Retraction guard');
  });

  it('holds the addendum within the constant budget B (aging ladder fit)', () => {
    // A tail-heavy doc against the smallest budget still fits.
    const bigTail = doc(NO_OWNER, {
      tail: Array.from({ length: 8 }, (_, i) => ({
        speaker: 'assistant' as const,
        text: 'x'.repeat(6000) + ` turn ${i}`,
        ts: null,
      })),
    });
    const spec = buildRespawnLaunchSpec({ doc: bigTail, effectiveWindowTokens: 1000, now: NOW });
    expect(spec.budgetChars).toBe(carryDocBudgetChars(1000)); // floors at 8*4000
    expect(spec.systemPromptAddendum.length).toBeLessThanOrEqual(spec.budgetChars);
  });
});

describe('buildRespawnLaunchSpec — first prompt (P-010)', () => {
  it('an OPEN owner message becomes the successor first prompt, verbatim', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(OPEN_DELIBERATE), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.firstPrompt).toBe('ship the release when the gate is green');
  });

  it('an OPEN owner message is delivered on a FORCED boundary too (carried, not lost)', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(OPEN_FORCED), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.firstPrompt).toBe('ship the release when the gate is green');
  });

  it('an ANSWERED owner message yields NO first prompt (already handled)', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(ANSWERED), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.firstPrompt).toBeNull();
  });

  it('no owner message ⇒ no first prompt (successor opens on the carry doc)', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(NO_OWNER), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.firstPrompt).toBeNull();
  });

  it('carries the FULL open owner message only in the first prompt; the addendum shows a truncated preview + framing', () => {
    // >240 chars: the continuation block previews the head (framing) but the tail
    // marker beyond the preview cap must live ONLY in the first prompt, never
    // duplicated as quoted history in the addendum (P-010 "never quoted material").
    const longText = 'PLEASE ' + 'x'.repeat(300) + ' UNIQUE_TAIL_MARKER';
    const cont: CarryDocContinuation = { lastOwnerMessage: { text: longText, ts: null }, answered: false, deliberate: true, selfRequested: true };
    const spec = buildRespawnLaunchSpec({ doc: doc(cont), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.firstPrompt).toContain('UNIQUE_TAIL_MARKER');
    expect(spec.systemPromptAddendum).not.toContain('UNIQUE_TAIL_MARKER');
    // The addendum still FRAMES it: the successor is told it arrives as the first prompt.
    expect(spec.systemPromptAddendum).toContain('FIRST PROMPT');
  });

  it('a plan-bound respawn appends the exact plans:get pointer to the first prompt', () => {
    const spec = buildRespawnLaunchSpec({
      doc: doc(OPEN_DELIBERATE),
      effectiveWindowTokens: 400_000,
      now: NOW,
      plan: { slug: 'deterministic-context-carry-2026-07-14', harness: 'papercusp' },
    });
    expect(spec.firstPrompt).toContain('ship the release when the gate is green');
    expect(spec.firstPrompt).toContain('deterministic-context-carry-2026-07-14');
    expect(spec.firstPrompt).toContain('plans:get');
  });
});

describe('buildRespawnLaunchSpec — open-owner-question gate (P-010)', () => {
  it('a DELIBERATE boundary across an OPEN owner message trips the gate', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(OPEN_DELIBERATE), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.openOwnerQuestion.crossesOpenOwnerMessage).toBe(true);
    expect(spec.openOwnerQuestion.refusalText).toBeTruthy();
    // Mirrors the pure gate exactly — no re-implementation.
    expect(spec.openOwnerQuestion).toEqual(gateOpenOwnerQuestion(OPEN_DELIBERATE));
  });

  it('a FORCED boundary across an OPEN owner message does NOT trip it (nothing to refuse)', () => {
    const spec = buildRespawnLaunchSpec({ doc: doc(OPEN_FORCED), effectiveWindowTokens: 400_000, now: NOW });
    expect(spec.openOwnerQuestion.crossesOpenOwnerMessage).toBe(false);
  });

  it('an answered / absent owner message never trips it', () => {
    expect(
      buildRespawnLaunchSpec({ doc: doc(ANSWERED), effectiveWindowTokens: 400_000, now: NOW }).openOwnerQuestion
        .crossesOpenOwnerMessage,
    ).toBe(false);
    expect(
      buildRespawnLaunchSpec({ doc: doc(NO_OWNER), effectiveWindowTokens: 400_000, now: NOW }).openOwnerQuestion
        .crossesOpenOwnerMessage,
    ).toBe(false);
  });

  it('carries an open coord:ask-owner ledger row alongside the transcript gate', () => {
    const spec = buildRespawnLaunchSpec({
      doc: doc(NO_OWNER, {
        asks: [{ id: 'conv-open', question: 'Which release route?', askedAtMs: NOW }],
      }),
      effectiveWindowTokens: 400_000,
      now: NOW,
    });
    // The conversation is open even though the transcript has no unanswered
    // human turn. request-compaction reports the union; P-010 consumers keep
    // using crossesOpenOwnerMessage for the transcript-only refuse-once gate.
    expect(spec.openOwnerAskCount).toBe(1);
    expect(spec.openOwnerQuestion.crossesOpenOwnerMessage).toBe(false);
  });
});

describe('deriveRespawnFirstPrompt (pure branch)', () => {
  it('returns the owner text only when present + unanswered', () => {
    expect(deriveRespawnFirstPrompt(doc(OPEN_DELIBERATE))).toBe('ship the release when the gate is green');
    expect(deriveRespawnFirstPrompt(doc(ANSWERED))).toBeNull();
    expect(deriveRespawnFirstPrompt(doc(NO_OWNER))).toBeNull();
  });

  it('guards a blank owner message from falling through to the empty-note kickoff', () => {
    const blank: CarryDocContinuation = { lastOwnerMessage: { text: '   \n  ', ts: null }, answered: false, deliberate: true, selfRequested: true };
    expect(deriveRespawnFirstPrompt(doc(blank))).toBeNull();
  });

  it('threads autoMode + plan through to deriveLaunchPromptText', () => {
    const out = deriveRespawnFirstPrompt(doc(OPEN_DELIBERATE), false, { slug: 'p', harness: 'papercusp' });
    expect(out).toContain('ship the release when the gate is green');
    expect(out).toContain('plans:get');
  });
});

describe('buildOwnerRespawnLaunchSpec — live fail-soft adapter', () => {
  it('builds with a deliberate threshold boundary by default', async () => {
    const buildFn = async (_ownerId: string, opts?: BuildCarryDocOpts) => {
      expect(opts?.boundaryDeliberate).toBe(true);
      return doc(NO_OWNER);
    };
    const out = await buildOwnerRespawnLaunchSpec('su-1', {
      effectiveWindowTokens: 400_000,
      buildFn,
    });
    expect(out?.systemPromptAddendum).toContain('Carry document (deterministic');
  });

  it('threads the effective role into CarryDoc so judge recovery stays safe', async () => {
    const buildFn = async (_ownerId: string, opts?: BuildCarryDocOpts) => {
      expect(opts?.role).toBe('judge');
      const base = doc(NO_OWNER);
      return {
        ...base,
        identity: { ...base.identity, role: opts?.role },
        automaticRecovery: null,
      };
    };
    const out = await buildOwnerRespawnLaunchSpec('su-1', {
      effectiveWindowTokens: 400_000,
      role: 'judge',
      buildFn,
    });
    expect(out?.systemPromptAddendum).toContain('evaluation context');
    expect(out?.systemPromptAddendum).not.toContain('coord:orient');
    expect(out?.systemPromptAddendum).not.toContain('sessions:search');
  });

  it('lets the live caller explicitly mark a forced boundary', async () => {
    const buildFn = async (_ownerId: string, opts?: BuildCarryDocOpts) => {
      expect(opts?.boundaryDeliberate).toBe(false);
      return doc(OPEN_FORCED);
    };
    const out = await buildOwnerRespawnLaunchSpec('su-1', {
      effectiveWindowTokens: 400_000,
      buildOpts: { boundaryDeliberate: false },
      buildFn,
    });
    expect(out?.openOwnerQuestion.crossesOpenOwnerMessage).toBe(false);
  });

  it('returns null for a blank owner or any builder failure', async () => {
    expect(
      await buildOwnerRespawnLaunchSpec('  ', {
        effectiveWindowTokens: 400_000,
        buildFn: async () => doc(NO_OWNER),
      }),
    ).toBeNull();
    expect(
      await buildOwnerRespawnLaunchSpec('su-1', {
        effectiveWindowTokens: 400_000,
        buildFn: async () => {
          throw new Error('db unavailable');
        },
      }),
    ).toBeNull();
  });
});
