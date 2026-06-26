/**
 * code-run-batch-nudge.test — the inline batch nudge (code-run-token-frugality, owner directive
 * 2026-06-23; fan-out + felt-cost + backoff upgrade 2026-06-26). Pure in-process logic with an
 * injectable clock, so these are deterministic unit tests.
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
  FANOUT_DISTINCT_THRESHOLD,
  NUDGE_WINDOW_MS,
  ORIENT_DEDUP_WINDOW_MS,
  CODE_RUN_CAPABLE_ROLES,
} from './code-run-batch-nudge';

const cap = { sessionKey: 's1', toolName: 'work_items:get', canCodeRun: true };

beforeEach(() => _resetBatchNudgeState());

describe('maybeBatchNudge — same-tool trigger (windowed)', () => {
  it('stays silent below the threshold, fires exactly AT it with kind=same-tool', () => {
    let t = 0;
    for (let i = 1; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      expect(maybeBatchNudge({ ...cap, now: t })).toBeNull(); // calls 1..N-1
    }
    t += 1000;
    const hit = maybeBatchNudge({ ...cap, now: t }); // the Nth call
    expect(hit?.kind).toBe('same-tool');
    expect(hit?.text).toContain('work_items:get');
    expect(hit?.text).toContain('code:run');
  });

  it('surfaces the FELT round-trip cost — the running count + the word round-trip', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ ...cap, now: t });
    }
    expect(hit?.text).toContain(`${BATCH_NUDGE_THRESHOLD}×`); // "3×"
    expect(hit?.text).toMatch(/round-trip/);
  });

  it('does NOT fire when the repeats fall OUTSIDE the window (only a bursty flurry trips it)', () => {
    expect(maybeBatchNudge({ ...cap, now: 0 })).toBeNull(); // count 1
    expect(maybeBatchNudge({ ...cap, now: 1000 })).toBeNull(); // count 2
    // 3rd call far beyond the window — the earlier two aged out, so the window count is 1.
    expect(maybeBatchNudge({ ...cap, now: NUDGE_WINDOW_MS + 2000 })).toBeNull();
  });

  it('states the correct boundary — judgment mid-flow, NOT data dependency', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ ...cap, now: t });
    }
    expect(hit?.text).toContain('mechanically-chained'); // dependent-but-mechanical IS batchable
    expect(hit?.text).toMatch(/read its result and DECIDE/); // the real cutoff is judgment
  });

  it('embeds a runnable list-then-loop skeleton over the EXACT repeated tool', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ ...cap, toolName: 'work_items:get', now: t });
    }
    expect(hit?.text).toContain('code:run { script:');
    expect(hit?.text).toContain('tools.work_items.get(a)'); // ns.camelVerb form, loop var
    expect(hit?.text).toMatch(/for \(const a of inputs\) out\.push\(await /);
    expect(hit?.text).toContain('return out;');
  });

  it('camelCases a hyphenated verb in the skeleton (set-status → setStatus)', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ ...cap, toolName: 'plans:set-status', now: t });
    }
    expect(hit?.text).toContain('tools.plans.setStatus(a)');
  });
});

describe('maybeBatchNudge — fan-out trigger (the ~70% the old nudge missed)', () => {
  const fanTools = ['plans:get', 'work_items:get', 'docs:search', 'coord:inbox'];

  it('fires with kind=fanout once ≥ FANOUT_DISTINCT_THRESHOLD distinct tools hit the window', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    let i = 0;
    // for-of (not forEach): assigning `hit` inside the loop body keeps TS's flow narrowing, so the
    // post-loop `hit?.kind` access is typed BatchNudgeResult|null, not narrowed-to-null.
    for (const toolName of fanTools) {
      t += 1000;
      hit = maybeBatchNudge({ sessionKey: 'fz', toolName, canCodeRun: true, now: t });
      if (i < FANOUT_DISTINCT_THRESHOLD - 1) expect(hit).toBeNull(); // below the distinct threshold
      i++;
    }
    expect(hit?.kind).toBe('fanout');
  });

  it('embeds a Promise.all skeleton over the EXACT distinct tools seen, in first-seen order', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const toolName of fanTools) {
      t += 1000;
      hit = maybeBatchNudge({ sessionKey: 'fz', toolName, canCodeRun: true, now: t });
    }
    expect(hit?.text).toContain('Promise.all');
    expect(hit?.text).toContain('tools.plans.get(');
    expect(hit?.text).toContain('tools.work_items.get(');
    expect(hit?.text).toContain('tools.docs.search(');
    expect(hit?.text).toContain('tools.coord.inbox(');
    expect(hit?.text).toMatch(/return \{ r0, r1, r2, r3 \}/);
  });

  it('surfaces the felt cost for the fan-out (distinct-tool + total-call counts)', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const toolName of fanTools) {
      t += 1000;
      hit = maybeBatchNudge({ sessionKey: 'fz', toolName, canCodeRun: true, now: t });
    }
    expect(hit?.text).toContain(`${FANOUT_DISTINCT_THRESHOLD} different tools`);
    expect(hit?.text).toMatch(/round-trip/);
  });

  it('does NOT fire below the distinct threshold even on many calls of < N tools', () => {
    let t = 0;
    // 3 distinct tools, each called twice = 6 calls, 3 distinct < 4, no same-tool ≥3 → silent.
    for (const toolName of ['a:x', 'b:y', 'c:z', 'a:x', 'b:y', 'c:z']) {
      t += 1000;
      expect(maybeBatchNudge({ sessionKey: 'fn', toolName, canCodeRun: true, now: t })).toBeNull();
    }
  });
});

describe('maybeBatchNudge — backoff (re-fires, NOT one-shot)', () => {
  it('re-fires on an exponential call-count cooldown instead of going permanently silent', () => {
    const fires: number[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) {
      t += 1000;
      if (maybeBatchNudge({ ...cap, now: t })) fires.push(i);
    }
    // First fire at the 3rd call (index 2); then re-fires after cooldowns 4, 8 (→ indices 6, 14).
    expect(fires).toEqual([2, 6, 14]);
    // The gap between consecutive fires strictly grows (exponential backoff, never spam).
    expect(fires[1] - fires[0]).toBeLessThan(fires[2] - fires[1]);
  });

  it('does NOT re-fire on the call immediately after a nudge (the cooldown is real)', () => {
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      maybeBatchNudge({ ...cap, now: t });
    }
    t += 1000;
    expect(maybeBatchNudge({ ...cap, now: t })).toBeNull(); // immediate next call — still cooling down
  });
});

describe('maybeBatchNudge — scoping guards (teeth)', () => {
  it('does NOT fire for a caller that cannot run code:run', () => {
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 2; i++) {
      t += 1000;
      expect(maybeBatchNudge({ ...cap, canCodeRun: false, now: t })).toBeNull();
    }
  });

  it('does NOT nudge the batch tools themselves, and never counts them toward fan-out', () => {
    let t = 0;
    for (const toolName of ['code:run', 'code_run', 'recipes:search', 'recipes_run']) {
      t += 1000;
      expect(maybeBatchNudge({ sessionKey: 'ex', toolName, canCodeRun: true, now: t })).toBeNull();
    }
    // Those four distinct EXCLUDED tools must NOT have populated the window — one real read is below
    // both thresholds, so still silent (proves excluded calls short-circuit before recording).
    t += 1000;
    expect(maybeBatchNudge({ sessionKey: 'ex', toolName: 'plans:get', canCodeRun: true, now: t })).toBeNull();
  });

  it('does NOT fire on an empty session key or empty tool name', () => {
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
      t += 1000;
      expect(maybeBatchNudge({ ...cap, sessionKey: '', now: t })).toBeNull();
      expect(maybeBatchNudge({ ...cap, toolName: '', now: t })).toBeNull();
    }
  });
});

describe('maybeBatchNudge — isolation', () => {
  it('tracks each (session, tool) independently for the same-tool trigger', () => {
    let t = 0;
    for (let i = 1; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      expect(maybeBatchNudge({ ...cap, toolName: 'plans:get', now: t })).toBeNull();
      expect(maybeBatchNudge({ ...cap, toolName: 'docs:get', now: t })).toBeNull();
    }
    t += 1000;
    // NOTE: by now the session has seen plans:get + docs:get + work_items:get-shaped names? No — only
    // two distinct tools here, below the fan-out threshold, so only the same-tool trigger can fire.
    expect(maybeBatchNudge({ ...cap, toolName: 'plans:get', now: t })?.text).toContain('plans:get');
  });

  it('does NOT bleed counts across sessions', () => {
    let t = 0;
    for (let i = 1; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      maybeBatchNudge({ ...cap, sessionKey: 'a', now: t });
    }
    // A fresh session starts at zero — one call is below threshold, so silent.
    t += 1000;
    expect(maybeBatchNudge({ ...cap, sessionKey: 'b', now: t })).toBeNull();
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
  it('includes EVERY built-in role (code:run is open to all roles, owner directive 2026-06-25)', () => {
    expect(CODE_RUN_CAPABLE_ROLES.has('worker')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('queen')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('bee')).toBe(true);
    // Previously-excluded non-SU/bee roles now qualify — the nudge fires for them too.
    expect(CODE_RUN_CAPABLE_ROLES.has('sentinel')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('overwatch')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('reviewer')).toBe(true);
  });
});
