/**
 * code-run-batch-nudge.test — the inline same-tool-N× batch nudge (code-run-token-frugality,
 * owner directive 2026-06-23). Pure in-process logic, so these are deterministic unit tests.
 *
 * TEETH: each "fires" assertion pairs with a "does NOT fire" under the same setup minus the one
 * triggering condition, so neutering a guard flips a test RED.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  maybeBatchNudge,
  maybeOrientDedupNudge,
  _resetBatchNudgeState,
  BATCH_NUDGE_THRESHOLD,
  ORIENT_DEDUP_WINDOW_MS,
  CODE_RUN_CAPABLE_ROLES,
} from './code-run-batch-nudge';

const cap = { sessionKey: 's1', toolName: 'work_items:get', canCodeRun: true };

beforeEach(() => _resetBatchNudgeState());

describe('maybeBatchNudge — threshold + one-shot', () => {
  it('stays silent below the threshold, fires exactly once AT it', () => {
    for (let i = 1; i < BATCH_NUDGE_THRESHOLD; i++) {
      expect(maybeBatchNudge(cap)).toBeNull(); // calls 1..N-1
    }
    const hit = maybeBatchNudge(cap); // the Nth call
    expect(hit).toContain('work_items:get');
    expect(hit).toContain('code:run');
  });

  it('is ONE-SHOT — never fires again for the same (session, tool) after the first', () => {
    for (let i = 1; i < BATCH_NUDGE_THRESHOLD; i++) maybeBatchNudge(cap);
    expect(maybeBatchNudge(cap)).not.toBeNull(); // fires
    for (let i = 0; i < 5; i++) expect(maybeBatchNudge(cap)).toBeNull(); // never again
  });

  it('states the correct boundary — judgment mid-flow, NOT data dependency', () => {
    let hit: string | null = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) hit = maybeBatchNudge(cap);
    expect(hit).toContain('mechanically-chained'); // dependent-but-mechanical IS batchable
    expect(hit).toMatch(/read its result and DECIDE/); // the real cutoff is judgment
  });
});

describe('maybeBatchNudge — scoping guards (teeth)', () => {
  it('does NOT fire for a caller that cannot run code:run', () => {
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 2; i++) {
      expect(maybeBatchNudge({ ...cap, canCodeRun: false })).toBeNull();
    }
  });

  it('does NOT nudge the batch tools themselves (code:run / recipes:*), in either name form', () => {
    for (const toolName of ['code:run', 'code_run', 'recipes:search', 'recipes_run']) {
      for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 2; i++) {
        expect(maybeBatchNudge({ ...cap, toolName })).toBeNull();
      }
    }
  });

  it('does NOT fire on an empty session key or empty tool name', () => {
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
      expect(maybeBatchNudge({ ...cap, sessionKey: '' })).toBeNull();
      expect(maybeBatchNudge({ ...cap, toolName: '' })).toBeNull();
    }
  });
});

describe('maybeBatchNudge — isolation', () => {
  it('tracks each (session, tool) independently', () => {
    // Two different tools in the SAME session: each needs its own N calls.
    for (let i = 1; i < BATCH_NUDGE_THRESHOLD; i++) {
      expect(maybeBatchNudge({ ...cap, toolName: 'plans:get' })).toBeNull();
      expect(maybeBatchNudge({ ...cap, toolName: 'docs:get' })).toBeNull();
    }
    expect(maybeBatchNudge({ ...cap, toolName: 'plans:get' })).toContain('plans:get');
    expect(maybeBatchNudge({ ...cap, toolName: 'docs:get' })).toContain('docs:get');
  });

  it('does NOT bleed counts across sessions', () => {
    for (let i = 1; i < BATCH_NUDGE_THRESHOLD; i++) maybeBatchNudge({ ...cap, sessionKey: 'a' });
    // A fresh session starts at zero — one call is below threshold, so silent.
    expect(maybeBatchNudge({ ...cap, sessionKey: 'b' })).toBeNull();
  });
});

describe('maybeBatchNudge — ready-to-paste skeleton (P-006)', () => {
  it('embeds a runnable code:run skeleton targeting the EXACT repeated tool', () => {
    let hit: string | null = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      hit = maybeBatchNudge({ ...cap, toolName: 'work_items:get' });
    }
    expect(hit).not.toBeNull();
    // a fill-in-the-blank loop over the EXACT tool, in the typed facade form
    expect(hit).toContain('code:run { script:');
    expect(hit).toContain('tools.work_items.get(a)'); // ns.camelVerb form
    expect(hit).toMatch(/for \(const a of inputs\) out\.push\(await /);
    expect(hit).toContain('return out;');
  });

  it('camelCases a hyphenated verb in the skeleton (set-status → setStatus)', () => {
    let hit: string | null = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      hit = maybeBatchNudge({ ...cap, toolName: 'plans:set-status' });
    }
    expect(hit).toContain('tools.plans.setStatus(a)');
  });
});

describe('maybeOrientDedupNudge (P-009) — soft, windowed, one-shot', () => {
  const KEY = 'spawn-1';

  it('nudges a subsumed fetch shortly after a successful orient, pointing back at orient', () => {
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 1000 })).toBeNull();
    const hit = maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:inbox', now: 2000 });
    expect(hit).toContain('coord:orient already returned');
    expect(hit).toContain('coord:inbox');
    expect(hit).toContain('inbox');
  });

  it('covers all four tools orient subsumes (plan-events / inbox / memory:search / declare-intent)', () => {
    for (const toolName of ['coord:plan-events', 'coord:inbox', 'memory:search', 'coord:declare-intent']) {
      _resetBatchNudgeState();
      maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 0 });
      expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName, now: 100 })).not.toBeNull();
    }
  });

  it('is ONE-SHOT per (session, subsumed tool)', () => {
    maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 0 });
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:inbox', now: 1 })).not.toBeNull();
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:inbox', now: 2 })).toBeNull();
  });

  it('does NOT fire without a preceding orient this session (a fresh fetch is legitimate)', () => {
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:inbox', now: 5000 })).toBeNull();
  });

  it('does NOT fire outside the window — a genuine LATER re-check is left alone', () => {
    maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 0 });
    const tooLate = ORIENT_DEDUP_WINDOW_MS + 1;
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:inbox', now: tooLate })).toBeNull();
  });

  it('does NOT nudge unrelated tools, and never nudges orient itself', () => {
    maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 0 });
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'plans:get', now: 10 })).toBeNull();
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord:orient', now: 20 })).toBeNull();
  });

  it('matches the MCP (underscore) name form too', () => {
    maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord_orient', now: 0 });
    expect(maybeOrientDedupNudge({ sessionKey: KEY, toolName: 'coord_inbox', now: 10 })).not.toBeNull();
  });
});

describe('CODE_RUN_CAPABLE_ROLES', () => {
  it('includes the coding pipeline roles + bee, excludes a read-only/non-code role', () => {
    expect(CODE_RUN_CAPABLE_ROLES.has('worker')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('queen')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('bee')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('sentinel')).toBe(false);
  });
});
