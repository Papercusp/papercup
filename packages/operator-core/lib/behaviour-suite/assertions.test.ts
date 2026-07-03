import { describe, it, expect } from 'vitest';
import { parseTranscript } from './transcript';
import { runChecks, type BehaviourContext } from './assertions';
import { buildReport } from './report';

// ---- fixture event builders (the parser also accepts already-parsed objects) ----
const modelChange = (model: string) => ({ type: 'model_change', model });
const userMsg = (text: string) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
const asstText = (text: string, model = 'maxwell1500/ornith-35b:IQ3_M') => ({
  type: 'message',
  message: { role: 'assistant', model, content: [{ type: 'text', text }] },
});
const asstErr = (message: string, status: number) => ({
  type: 'message',
  message: { role: 'assistant', model: 'claude-sonnet-4-6', content: [], stopReason: 'error', errorMessage: message, errorStatus: status },
});
const toolCall = (name: string, args: Record<string, unknown>) => ({
  type: 'message',
  message: { role: 'assistant', model: 'maxwell1500/ornith-35b:IQ3_M', content: [{ type: 'toolCall', id: 'x', name: `mcp__papercusp_su_${name}`, arguments: JSON.stringify(args) }] },
});
const toolResult = (text: string) => ({ type: 'message', message: { role: 'tool', content: [{ type: 'tool_result', text }] } });
const inject = (text: string) => ({ type: 'custom_message', customType: 'coord-reminder', content: text });

const ORNITH_CTX: BehaviourContext = { expectedModelSubstr: 'ornith', expectedWorkItemIds: ['WI-1', 'WI-2'] };
const byId = (t: ReturnType<typeof parseTranscript>, ctx: BehaviourContext) => {
  const map: Record<string, ReturnType<typeof runChecks>[number]> = {};
  for (const c of runChecks(t, ctx)) map[c.id] = c;
  return map;
};

describe('behaviour-suite transcript parser', () => {
  it('normalizes models, kickoff, tool calls (mcp prefix stripped), results, injections', () => {
    const t = parseTranscript([
      modelChange('ollama-cc/maxwell1500/ornith-35b:IQ3_M'),
      userMsg('You have been handed this plan to implement.'),
      toolCall('plans_get', { slug: 'p' }),
      toolResult('ok'),
      inject('Plans changed since you last read'),
    ]);
    expect(t.models[0]).toContain('ornith');
    expect(t.firstUserTurn).toMatch(/handed this plan/);
    expect(t.toolCalls[0].name).toBe('plans:get');
    expect(t.toolCalls[0].malformed).toBe(false);
    expect(t.systemReminders.length).toBe(1);
  });

  it('flags a malformed (non-JSON) tool-call arguments string', () => {
    const t = parseTranscript([
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'mcp__papercusp_su_plans_get', arguments: '{slug: broken' }] } },
    ]);
    expect(t.toolCalls[0].malformed).toBe(true);
    expect(t.toolCalls[0].args).toBeNull();
  });
});

describe('behaviour checks — a clean ornith run passes', () => {
  const t = parseTranscript([
    modelChange('ollama-cc/maxwell1500/ornith-35b:IQ3_M'),
    userMsg('You have been handed this plan to implement. Read it with plans:get then present options.'),
    toolCall('plans_get', { slug: 'p' }),
    asstText('Here is the plan. Options: (A) do it yourself, (B) hand it to the Queen, or (C) launch a fleet. I recommend A. Confirm which route?'),
    userMsg('do it yourself'),
    toolCall('work_items_claim', { ids: ['WI-1', 'WI-2'] }),
    toolCall('work_items_set_state', { items: [{ id: 'WI-1', state: 'in_progress' }] }),
    toolCall('work_items_complete', { items: [{ id: 'WI-1', completion: { summary: 'verified in sync against hlc.ts, no drift' } }] }),
    toolCall('work_items_complete', { items: [{ id: 'WI-2', completion: { summary: 'edited the .mdx doc to match source' } }] }),
  ]);
  const checks = byId(t, ORNITH_CTX);

  it('passes model-routing, context-fit, routing-gate, plan-execution, scope, lock-discipline', () => {
    expect(checks['model-routing'].passed).toBe(true);
    expect(checks['context-fit'].passed).toBe(true);
    expect(checks['routing-gate'].passed).toBe(true);
    expect(checks['plan-execution'].passed).toBe(true);
    expect(checks['scope-adherence'].passed).toBe(true);
    expect(checks['lock-discipline'].passed).toBe(true);
    expect(checks['completion-evidence'].passed).toBe(true);
  });
  it('overall verdict is pass', () => {
    expect(buildReport(runChecks(t, ORNITH_CTX)).verdict).toBe('pass');
  });
});

describe('behaviour checks — catches every real bug we hit', () => {
  it('model-routing FAILS on silent cloud fallback + 429 (session 9855/smoke1)', () => {
    const t = parseTranscript([modelChange('papercusp-gateway/claude-sonnet-4-6'), asstErr('429 rate_limit_error', 429)]);
    expect(byId(t, ORNITH_CTX)['model-routing'].passed).toBe(false);
  });

  it('model-routing FAILS on "no reachable local backend" saturation (session 9855)', () => {
    const t = parseTranscript([modelChange('maxwell1500/ornith-35b:IQ3_M'), asstErr('502 inference-gateway: no reachable local backend for model', 502)]);
    expect(byId(t, ORNITH_CTX)['model-routing'].passed).toBe(false);
  });

  it('context-fit FAILS on the turn-1 compaction wedge (session 9858)', () => {
    const t = parseTranscript([modelChange('maxwell1500/ornith-35b:IQ3_M'), inject('Compaction freed too little context to make progress')]);
    expect(byId(t, ORNITH_CTX)['context-fit'].passed).toBe(false);
  });

  it('plan-execution FAILS on direct set_state passed (session 9870)', () => {
    const t = parseTranscript([
      modelChange('maxwell1500/ornith-35b:IQ3_M'),
      toolCall('work_items_claim', { ids: ['WI-1'] }),
      toolCall('work_items_set_state', { items: [{ id: 'WI-1', state: 'passed' }] }),
      toolResult("completion-integrity: work_item 'WI-1' → 'passed' rejected — a terminal transition"),
    ]);
    expect(byId(t, ORNITH_CTX)['plan-execution'].passed).toBe(false);
  });

  it('scope-adherence FAILS on invented Phase 2 / unrelated backlog (session 9870)', () => {
    const t = parseTranscript([
      modelChange('maxwell1500/ornith-35b:IQ3_M'),
      toolCall('work_items_claim', { i: 'Claim work items for Phase 2 doc drift verification', ids: ['WI-999'] }),
    ]);
    expect(byId(t, ORNITH_CTX)['scope-adherence'].passed).toBe(false);
  });

  it('lock-discipline FAILS on locking a file to "serialize fleet creation" (session 9869)', () => {
    const t = parseTranscript([
      modelChange('maxwell1500/ornith-35b:IQ3_M'),
      toolCall('locks_acquire_granular', { i: 'Exclusive lock on the plan file to serialize fleet creation', path: 'docs/plans/p.md', mode: 'X' }),
    ]);
    expect(byId(t, ORNITH_CTX)['lock-discipline'].passed).toBe(false);
  });

  it('fleet-launch FAILS on a hand-rolled psu missing --agent (session 9865)', () => {
    const t = parseTranscript([
      modelChange('maxwell1500/ornith-35b:IQ3_M'),
      toolCall('capability_terminal', { terminals: [{ command: 'psu --no-picker --fleet=f --role=su --workspace=w --plan=p' }] }),
    ]);
    const c = byId(t, { ...ORNITH_CTX, fleetExpected: true })['fleet-launch'];
    expect(c.passed).toBe(false);
    expect(c.na).toBeFalsy();
  });

  it('fleet-launch is n/a when no fleet was launched', () => {
    const t = parseTranscript([modelChange('maxwell1500/ornith-35b:IQ3_M'), toolCall('plans_get', { slug: 'p' })]);
    expect(byId(t, ORNITH_CTX)['fleet-launch'].na).toBe(true);
  });

  it('routing-gate FAILS when it guesses plan:// instead of plans:get', () => {
    const t = parseTranscript([
      modelChange('maxwell1500/ornith-35b:IQ3_M'),
      userMsg('implement this plan'),
      toolResult("Path 'plan://ornith-doc-resync-batch' not found"),
    ]);
    expect(byId(t, ORNITH_CTX)['routing-gate'].passed).toBe(false);
  });
});

describe('routing-gate is N/A for an AUTO-on fleet MEMBER (WI-1848 / WI-1849)', () => {
  // A fleet member in AUTO correctly does NOT present the A/B/C route menu — it just
  // orients, claims its lane, and works. That (correctly) trips the routing-gate check,
  // which is the AUTO-off / leader posture; the autoFleetMember flag marks it N/A instead
  // of a false fail.
  const memberRun = parseTranscript([
    modelChange('ollama-cc/maxwell1500/ornith-35b:IQ3_M'),
    userMsg('You are a fleet MEMBER. AUTO mode is ON. Continue where you left off.'),
    toolCall('coord_orient', { intent: 'pull next shared-floor item' }),
    toolCall('work_items_claim', { ids: ['WI-1'] }),
    toolCall('work_items_set_state', { items: [{ id: 'WI-1', state: 'in_progress' }] }),
    toolCall('work_items_complete', { items: [{ id: 'WI-1', completion: { summary: 'built + tested green' } }] }),
  ]);

  it('is N/A (not a fail) when ctx.autoFleetMember is set', () => {
    const c = byId(memberRun, { ...ORNITH_CTX, autoFleetMember: true })['routing-gate'];
    expect(c.na).toBe(true);
    expect(c.passed).toBe(true);
  });

  it('is EXCLUDED from the verdict, so a clean member run still passes overall', () => {
    const report = buildReport(runChecks(memberRun, { ...ORNITH_CTX, autoFleetMember: true }));
    expect(report.verdict).toBe('pass');
    expect(report.criticalFailures).not.toContain('routing-gate');
  });

  it('WITHOUT the flag the same no-menu run trips routing-gate — proving the flag is what excuses it', () => {
    const c = byId(memberRun, ORNITH_CTX)['routing-gate'];
    expect(c.na).toBeFalsy();
    expect(c.passed).toBe(false);
  });
});
