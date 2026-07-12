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
    // next call far beyond the window — the first aged out, so the window count is back to 1.
    expect(maybeBatchNudge({ ...cap, now: NUDGE_WINDOW_MS + 2000 })).toBeNull();
    // and one more a window later — again the prior aged out, still a window count of 1.
    expect(maybeBatchNudge({ ...cap, now: 2 * (NUDGE_WINDOW_MS + 2000) })).toBeNull();
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
    expect(hit?.text).toContain('tools.workItems.get(a)'); // camelNamespace.camelVerb form, loop var
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
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    let i = 0;
    for (const toolName of fanTools) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey: 'fz', toolName, canCodeRun: true, now: t });
      if (i < FANOUT_DISTINCT_THRESHOLD - 1) expect(r).toBeNull(); // below the distinct threshold
      if (r && !firstFire) firstFire = r; // capture the fire — a later call cools down to null
      i++;
    }
    expect(firstFire?.kind).toBe('fanout');
  });

  it('embeds a Promise.all skeleton over the EXACT distinct tools seen, in first-seen order', () => {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const toolName of fanTools) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey: 'fz', toolName, canCodeRun: true, now: t });
      if (r && !firstFire) firstFire = r; // the fire carries the tools seen UP TO the threshold
    }
    expect(firstFire?.text).toContain('Promise.all');
    // first-seen order, capped at the distinct threshold — the trailing tool fires later, in cooldown
    expect(firstFire?.text).toContain('tools.plans.get(');
    expect(firstFire?.text).toContain('tools.workItems.get(');
    expect(firstFire?.text).toContain('tools.docs.search(');
    expect(firstFire?.text).toMatch(/return \{ r0, r1, r2 \}/);
  });

  it('surfaces the felt cost for the fan-out (distinct-tool + total-call counts)', () => {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const toolName of fanTools) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey: 'fz', toolName, canCodeRun: true, now: t });
      if (r && !firstFire) firstFire = r;
    }
    expect(firstFire?.text).toContain(`${FANOUT_DISTINCT_THRESHOLD} different tools`);
    expect(firstFire?.text).toMatch(/round-trip/);
  });

  it('does NOT fire below BOTH thresholds — two distinct single reads stay silent', () => {
    let t = 0;
    // 2 distinct tools, each once: distinct (2) < FANOUT_DISTINCT_THRESHOLD AND maxSameTool (1) <
    // BATCH_NUDGE_THRESHOLD → below both triggers, so silent regardless of the (lowered) thresholds.
    for (const toolName of ['a:x', 'b:y']) {
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
    // First fire at the 2nd call (index 1, threshold lowered 3→2); then re-fires after cooldowns
    // 4, 8 (→ indices 5, 13).
    expect(fires).toEqual([1, 5, 13]);
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

describe('maybeBatchNudge — escalation (the text gets firmer as nudges repeat)', () => {
  it('first fire is neutral; later fires carry progressively firmer banners', () => {
    const texts: string[] = [];
    let t = 0;
    for (let i = 0; i < 20; i++) {
      t += 1000;
      const r = maybeBatchNudge({ ...cap, now: t });
      if (r) texts.push(r.text);
    }
    expect(texts).toHaveLength(3); // fires at indices 1, 5, 13 (see backoff test)
    expect(texts[0]).not.toMatch(/reminder this session/); // 1st = the original neutral message
    expect(texts[1]).toContain('2nd reminder this session'); // 2nd = firmer
    expect(texts[2]).toContain('3rd reminder this session'); // 3rd = stronger / directive
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
    expect(CODE_RUN_CAPABLE_ROLES.has('mug')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('cup')).toBe(true);
    // Previously-excluded non-SU/bee roles now qualify — the nudge fires for them too.
    expect(CODE_RUN_CAPABLE_ROLES.has('papercup')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('kettle')).toBe(true);
    expect(CODE_RUN_CAPABLE_ROLES.has('reviewer')).toBe(true);
  });
});

// ── code-run-self-state-adoption-2026-07-03 P-004: surface-aware nudging ──────────────

import { canRoleActOnCodeRun } from './code-run-batch-nudge';

describe('canRoleActOnCodeRun — envelope-aware capability check (P-004)', () => {
  it('allows default-allow fleet roles (bee, queen, worker)', () => {
    for (const role of ['cup', 'mug', 'worker']) {
      expect(canRoleActOnCodeRun(role), role).toBe(true);
    }
  });

  it('refuses envelope-denied roles (overwatch/sentinel deny capability:bash) and unknown roles', () => {
    expect(canRoleActOnCodeRun('kettle')).toBe(false);
    expect(canRoleActOnCodeRun('papercup')).toBe(false);
    expect(canRoleActOnCodeRun('totally-unknown-role')).toBe(false);
  });
});

describe('maybeBatchNudge — codeRunInSurface teaches the activate path (P-004)', () => {
  it('appends the tools:find/tools:invoke path when the surface lacks code:run', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      hit = maybeBatchNudge({ ...cap, codeRunInSurface: false, now: i * 1000 });
    }
    expect(hit).not.toBeNull();
    expect(hit!.text).toContain('not in your loaded tool list');
    expect(hit!.text).toContain('tools:find("code:run")');
    expect(hit!.text).toContain('tools:invoke');
  });

  it('does NOT append the activate path when the surface has code:run (default)', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      hit = maybeBatchNudge({ ...cap, now: i * 1000 });
    }
    expect(hit).not.toBeNull();
    expect(hit!.text).not.toContain('not in your loaded tool list');
  });
});

// ── code-run-batch-adoption-2026-07-12: tools:invoke unwrap (P-001), pipeline kind (P-002),
//    arg-prefilled skeletons (P-003). Distilled from the 2026-07-11 release-fleet burst: 8 serial
//    round-trips (3× release via tools:invoke + claim + comment on ONE work-item) that three
//    escalating hints failed to convert — each test below pins the blind spot that hid it. ──────

describe('maybeBatchNudge — tools:invoke unwrap (P-001)', () => {
  it('counts a tools:invoke-routed call as its INNER tool — a wrapped burst trips same-tool', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({
        sessionKey: 'inv1',
        toolName: 'tools:invoke',
        args: { name: 'work_items:release', args: { id: `WI-${1000 + i}` } },
        canCodeRun: true,
        now: t,
      });
    }
    expect(hit?.kind).toBe('same-tool');
    expect(hit?.tool).toBe('work_items:release');
    expect(hit?.text).toContain('work_items:release');
    expect(hit?.text).toContain('tools.workItems.release(a)');
  });

  it('matches the MCP underscore wrapper form (tools_invoke) too', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({
        sessionKey: 'inv2',
        toolName: 'tools_invoke',
        args: { name: 'plans:get', args: { slug: `plan-${i}` } },
        canCodeRun: true,
        now: t,
      });
    }
    expect(hit?.kind).toBe('same-tool');
    expect(hit?.tool).toBe('plans:get');
  });

  it('keeps the EXCLUSION on the inner tool — tools:invoke{name:"code:run"} never nudges or counts', () => {
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD + 1; i++) {
      t += 1000;
      expect(
        maybeBatchNudge({
          sessionKey: 'inv3',
          toolName: 'tools:invoke',
          args: { name: 'code:run', args: { script: 'return 1' } },
          canCodeRun: true,
          now: t,
        }),
      ).toBeNull();
    }
  });

  it('falls back to the wrapper name on malformed wrapper args', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({
        sessionKey: 'inv4',
        toolName: 'tools:invoke',
        args: { nope: 'no-name-key' },
        canCodeRun: true,
        now: t,
      });
    }
    expect(hit?.tool).toBe('tools:invoke');
  });
});

describe('maybeBatchNudge — pipeline kind (P-002): a chained burst is not "independent"', () => {
  const chainedCalls = [
    { toolName: 'work_items:release', args: { id: 'WI-4222', force: true } },
    { toolName: 'work_items:claim', args: { id: 'WI-4222', assignee: 'su-86bf' } },
    { toolName: 'work_items:comment', args: { id: 'WI-4222', body: 'reassigned' } },
  ];

  function fireChained(sessionKey: string): ReturnType<typeof maybeBatchNudge> {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const c of chainedCalls) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey, ...c, canCodeRun: true, now: t });
      if (r && !firstFire) firstFire = r;
    }
    return firstFire;
  }

  it('fires kind=pipeline when the same id threads through different tools', () => {
    const hit = fireChained('pl1');
    expect(hit?.kind).toBe('pipeline');
    expect(hit?.text).toContain('CHAINED');
    // The old text's false exemption is gone: a chain must never be called independent.
    expect(hit?.text).not.toContain('independent fan-out');
  });

  it('renders a SEQUENTIAL skeleton (awaits in order, no Promise.all), args prefilled', () => {
    const hit = fireChained('pl2');
    expect(hit?.text).not.toContain('Promise.all');
    expect(hit?.text).toMatch(/const r0 = await tools\.workItems\.release\(\{"id":"WI-4222"/);
    expect(hit?.text).toMatch(/const r1 = await tools\.workItems\.claim\(/);
    expect(hit?.text).toContain('return { r0, r1, r2 }');
  });

  it('stays kind=fanout when the only shared values sit under ambient-context keys (harness etc.)', () => {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const toolName of ['plans:get', 'docs:search', 'coord:inbox']) {
      t += 1000;
      const r = maybeBatchNudge({
        sessionKey: 'pl3',
        toolName,
        args: { harness: 'papercusp' },
        canCodeRun: true,
        now: t,
      });
      if (r && !firstFire) firstFire = r;
    }
    expect(firstFire?.kind).toBe('fanout');
  });
});

describe('maybeBatchNudge — arg-prefilled skeletons (P-003)', () => {
  it('prefills the same-tool `inputs` list with the burst\'s actual args', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (const id of ['WI-1111', 'WI-2222']) {
      t += 1000;
      hit = maybeBatchNudge({ sessionKey: 'pf1', toolName: 'work_items:get', args: { id }, canCodeRun: true, now: t });
    }
    expect(hit?.text).toContain('{"id":"WI-1111"},');
    expect(hit?.text).toContain('{"id":"WI-2222"},');
    expect(hit?.text).toContain('extend this list');
  });

  it('prefills the fan-out skeleton with each tool\'s last args; empty args keep the placeholder', () => {
    let firstFire: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    const calls = [
      { toolName: 'plans:get', args: { slug: 'alpha-plan' } },
      { toolName: 'docs:search', args: { q: 'beta-topic' } },
      { toolName: 'coord:glance', args: {} },
    ];
    for (const c of calls) {
      t += 1000;
      const r = maybeBatchNudge({ sessionKey: 'pf2', ...c, canCodeRun: true, now: t });
      if (r && !firstFire) firstFire = r;
    }
    expect(firstFire?.kind).toBe('fanout');
    expect(firstFire?.text).toContain('tools.plans.get({"slug":"alpha-plan"})');
    expect(firstFire?.text).toContain('tools.docs.search({"q":"beta-topic"})');
    expect(firstFire?.text).toContain('tools.coord.glance(/* args */)');
  });

  it('escapes backticks and ${ in prefilled args so the skeleton stays pasteable', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({
        sessionKey: 'pf3',
        toolName: 'docs:add',
        args: { text: 'a `tick` and ${x}' },
        canCodeRun: true,
        now: t,
      });
    }
    expect(hit?.text).toContain("\\`tick\\`");
    expect(hit?.text).toContain("\\${x}");
  });

  it('truncates an oversize args literal with a fill-in marker', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    const big = 'x'.repeat(500);
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ sessionKey: 'pf4', toolName: 'docs:add', args: { text: big }, canCodeRun: true, now: t });
    }
    expect(hit?.text).toContain('…truncated — fill in the rest');
  });

  it('reports the effective tool on every result (plain calls too)', () => {
    let hit: ReturnType<typeof maybeBatchNudge> = null;
    let t = 0;
    for (let i = 0; i < BATCH_NUDGE_THRESHOLD; i++) {
      t += 1000;
      hit = maybeBatchNudge({ sessionKey: 'pf5', toolName: 'plans:get', canCodeRun: true, now: t });
    }
    expect(hit?.tool).toBe('plans:get');
  });
});
