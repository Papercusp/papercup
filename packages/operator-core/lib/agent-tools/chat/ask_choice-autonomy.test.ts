/**
 * chat:ask_choice — B-17 autonomy wiring (queen-autonomous-execution P-040/P-043).
 *
 * Covers the EXECUTION half of the question gate that B-17 adds atop B-10's
 * interception:
 *   - the bee SELF-ANSWER short-circuit (rung 'bee-self' → return without blocking
 *     or escalating — P-040), only reachable once the autonomy gate is armed;
 *   - the decision-context threading (the bee's declared action/risk/reversibility
 *     reaches the gate — P-040's schema);
 *   - the posture→rung contract + the boot wiring (P-043).
 *
 * The autonomy gate is injected directly (configureAgentQuestionGate) so these are
 * pure unit tests — no PG, no arming flag. The real decider-backed gate is
 * behavior-neutral by construction (it fail-safes to owner-queue while disarmed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetCardCorrelatorForTests, _resetStateChannelForTests } from '@papercusp/agent-mcp';

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(), onFlagChange: vi.fn() }));
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { configureCoordLog, resetCoordLog } from '../coordination/log';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { listEscalations } from '../coordination/escalations';
import {
  configureAgentQuestionGate,
  resetAgentQuestionGate,
  type AgentQuestionInput,
} from '../coordination/agent-question-gate';
import { postureToRung } from '../coordination/agent-question-decider-gate';
import askChoiceTool from './ask_choice';

const ws = 'workspace-AC17';

// A bee: verified fleet-spawn ⇒ resolveAgentIdentity returns source:'fleet-spawn'.
const beeCtx = (askUser: unknown) => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: ws,
  runId: 'r-bee17',
  uiClientId: 'opspawn-bee-17',
  sigVerifiedSpawn: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  askUser: askUser as any,
});

const capturingAskUser = (corr: string) =>
  vi.fn(async (spec: { onCard?: (i: { correlationId: string; runId: string; workspaceId: string }) => void }) => {
    spec.onCard?.({ correlationId: corr, runId: 'r-bee17', workspaceId: ws });
    return { action: 'submit', payload: { picks: ['a'] } };
  });

describe('postureToRung contract (P-043 — keep in sync with the persona)', () => {
  it('gated → owner-queue, auto → bee-self', () => {
    expect(postureToRung('gated')).toBe('owner-queue');
    expect(postureToRung('auto')).toBe('bee-self');
  });
});

describe('wire-agent-question-gate boot (P-043)', () => {
  afterEach(() => resetAgentQuestionGate());
  it('imports + installs a gate without throwing (behavior-neutral side-effect)', async () => {
    await expect(import('../coordination/wire-agent-question-gate')).resolves.toBeDefined();
  });
});

describe('chat:ask_choice — B-17 autonomy wiring', () => {
  beforeEach(() => {
    configureCoordLog(new InMemoryCoordLog());
    _resetCardCorrelatorForTests();
    _resetStateChannelForTests();
    vi.mocked(getFlag).mockReset();
    vi.mocked(getFlag).mockImplementation(async (key: unknown) => key === FLAGS.MUG_CARD_INTERCEPTION);
  });
  afterEach(() => {
    resetCoordLog();
    resetAgentQuestionGate();
  });

  it("rung 'bee-self' (P-040): short-circuits — returns self_decide WITHOUT blocking the card or escalating", async () => {
    configureAgentQuestionGate(() => ({ rung: 'bee-self' }));
    const askUser = vi.fn(async () => ({ action: 'submit', payload: { picks: ['a'] } }));

    const r = await (askChoiceTool as any).handler(
      {
        question: 'tweak the retry backoff to 2s?',
        options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }],
        decision: { action: 'config:set', riskTier: 'low', reversibility: 'reversible' },
      },
      beeCtx(askUser),
    );

    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.self_decide).toBe(true);
    expect(parsed.rung).toBe('bee-self');
    expect(askUser).not.toHaveBeenCalled(); // never freezes on the owner
    expect((await listEscalations()).length).toBe(0); // no owner escalation
  });

  it('threads the bee-declared decision-context into the gate (P-040 schema)', async () => {
    let seen: AgentQuestionInput | null = null;
    configureAgentQuestionGate((input) => {
      seen = input;
      return { rung: 'owner-queue' };
    });
    const askUser = capturingAskUser('corr-ctx');

    await (askChoiceTool as any).handler(
      {
        question: 'irreversible delete — go?',
        options: [{ id: 'a', label: 'Yes' }],
        decision: { action: 'work_items:set_state', riskTier: 'high', authority: 'owner', reversibility: 'irreversible' },
      },
      beeCtx(askUser),
    );

    expect(seen).not.toBeNull();
    expect(seen!.action).toBe('work_items:set_state');
    expect(seen!.riskTier).toBe('high');
    expect(seen!.authority).toBe('owner');
    expect(seen!.reversibility).toBe('irreversible');
  });

  it("rung 'owner-queue' still blocks + escalates (the disarmed default is unchanged)", async () => {
    configureAgentQuestionGate(() => ({ rung: 'owner-queue' }));
    const askUser = capturingAskUser('corr-oq');

    const r = await (askChoiceTool as any).handler(
      { question: 'q?', options: [{ id: 'a', label: 'A' }], decision: { action: 'deploy:harness' } },
      beeCtx(askUser),
    );

    expect(askUser).toHaveBeenCalled(); // owner-queue path blocks on the card
    const escs = await listEscalations();
    expect(escs.length).toBe(1);
    expect((escs[0] as Record<string, unknown>).rung).toBe('owner-queue');
    const parsed = JSON.parse((r.content[0] as { text: string }).text);
    expect(parsed.self_decide).toBeUndefined();
  });
});
