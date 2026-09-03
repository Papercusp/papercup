/**
 * config:role-launch — the resolved answer REACHES the surface a reader consults.
 *
 * Plan role-model-one-answer-2026-09-03, P-004/P-005. `fleet/role-launch.test.ts`
 * already pins what the RESOLVER computes; this file pins what the TOOL actually
 * hands back, which is a different failure surface and had no detector.
 *
 * WHY IT EXISTS. The acceptance rubric's `contradiction-reported-never-silently-
 * resolved` and `answer-readable-before-any-spawn` criteria were bound only to
 * tests that could not go red for their own drift markers: a conflict could be
 * computed correctly on the resolver result and still never reach `conflicts[]`,
 * and `cell-registrations.test.ts` asserts only that the string `agent.roleLaunch`
 * appears in a registration census — it stays green if the surface renders
 * garbage. Both gaps are the same shape as the bug the plan fixed: the value was
 * right somewhere, and the place a human looked never showed it.
 *
 * Falsifiable in BOTH directions, because each alone is satisfiable by a stub:
 *   • TOO WEAK  → a conflict that never reaches `conflicts[]`/`verdict` (a silent
 *     wrong CLI), or rows that carry the model but drop `backend`/`source`, which
 *     leaves "why is it this?" unanswerable without burning a spawn.
 *   • TOO STRONG → a MATCHING backend pair reported as a conflict. A readout that
 *     cries wolf on the ordinary consistent case gets tuned out, which is
 *     operationally the same as having no warning at all.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/config/role-launch.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock('../../agent-config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../agent-config')>();
  return { ...real, readAgentConfig: readMock };
});

const tool = (await import('./role-launch')).default;

type Row = {
  role: string;
  model: string | null;
  backend: string | null;
  source: string;
  backendSource: string | null;
  conflict: { configured: string; effective: string; note: string } | null;
};
type Out = {
  data: {
    verdict: string;
    population: string;
    roles: Row[];
    conflicts: string[];
    backendUndetermined: string[];
  };
};

/** ctx `{}` names no concrete workspace/pot, so the tool reads the workspace
    answer and never touches owner-steering — the same shape the route uses. */
const run = async (args: { roles?: string[] } = {}) => (await tool.handler(args, {} as never)) as Out;

const cfg = (over: Record<string, unknown>) => ({
  backend: 'auto',
  cmd: '',
  models: {},
  roleBackends: {},
  tiers: [],
  tierCeilings: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('config:role-launch — the contradiction reaches the reader', () => {
  it('hoists a disagreeing roleBackends onto conflicts[] and the verdict, not just the row', async () => {
    // `sol:xhigh` is a codex spec; the operator asked for claude-code. The model
    // wins (D-002) — the point here is that the OVERRULED setting is reported.
    readMock.mockResolvedValue(
      cfg({
        models: { 'release-fixer': 'sol:xhigh' },
        roleBackends: { 'release-fixer': 'claude-code' },
      }),
    );
    const out = await run();

    expect(out.data.verdict).toBe('conflicted');
    expect(out.data.conflicts).toEqual(['release-fixer']);

    const row = out.data.roles.find((r) => r.role === 'release-fixer');
    expect(row?.backend).toBe('codex');
    // Never silently applied, never silently dropped: the configured value is
    // still legible next to the effective one.
    expect(row?.conflict).toMatchObject({ configured: 'claude-code', effective: 'codex' });
  });

  it('CRY-WOLF CONTROL: a MATCHING backend pair is not reported as a conflict', async () => {
    // Without this, a handler hard-wired to report every roleBackends entry as a
    // conflict would satisfy the case above while making the warning worthless.
    readMock.mockResolvedValue(
      cfg({
        models: { mug: 'claude-opus-5:xhigh' },
        roleBackends: { mug: 'claude-code' },
      }),
    );
    const out = await run();

    expect(out.data.conflicts).toEqual([]);
    expect(out.data.verdict).toBe('consistent');
    expect(out.data.roles.find((r) => r.role === 'mug')?.conflict).toBeNull();
  });

  it('reports an inherited (undetermined) backend separately from a contradicted one', async () => {
    // `mug` runs its COMMITTED DEFAULT here, which per D-002 pins the model but
    // NOT the CLI — it inherits the host's AGENT_CMD, reported as undetermined
    // rather than as a conflict. Collapsing the two would let a genuinely wrong
    // CLI hide inside the ordinary inherited case.
    readMock.mockResolvedValue(
      cfg({
        models: { 'release-fixer': 'sol:xhigh' },
        roleBackends: { 'release-fixer': 'claude-code' },
      }),
    );
    // `mug` is asked for BY NAME rather than given a ceiling: a ceiling would
    // resolve it off the tier menu (which carries its own backend) and destroy
    // the very case under test — the unpinned, purely-inherited CLI.
    const out = await run({ roles: ['mug', 'release-fixer'] });

    expect(out.data.backendUndetermined).toEqual(['mug']);
    expect(out.data.roles.find((r) => r.role === 'mug')).toMatchObject({
      source: 'committed-default',
      backend: null,
      backendSource: 'inherit',
      conflict: null,
    });
    expect(out.data.conflicts).toEqual(['release-fixer']);
    // conflicted outranks undetermined: a wrong CLI beats an inherited one.
    expect(out.data.verdict).toBe('conflicted');
  });
});

describe('config:role-launch — the answer is readable without a spawn', () => {
  it('renders model, backend AND which rule won for every configured role', async () => {
    readMock.mockResolvedValue(cfg({ models: { mug: 'claude-opus-5:xhigh' } }));
    const out = await run();

    const row = out.data.roles.find((r) => r.role === 'mug');
    // All three, together: the model alone leaves "why is it this?" unanswerable,
    // which is the original complaint only half-addressed.
    expect(row).toMatchObject({
      role: 'mug',
      model: 'claude-opus-5:xhigh',
      backend: 'claude-code',
      source: 'per-role',
    });
    expect(row?.backendSource).toBeTruthy();
    expect(row?.conflict).toBeNull();
  });

  it('POSITIVE CONTROL: the tier menu still resolves when no per-role model is set', async () => {
    // Guards the vacuous pass where explicit-wins is "achieved" by breaking every
    // other source: a system that only ever answered from models[role] would
    // satisfy the case above while regressing the tier menu to nothing.
    // `ghost-role` has no committed default, so the ceiling resolves it off the
    // menu — the model VALUE is deliberately not asserted (it tracks
    // DEFAULT_MODEL_TIERS, which this test does not own); that the tier menu
    // answered at all is the property under guard.
    readMock.mockResolvedValue(cfg({ tierCeilings: { 'ghost-role': 'standard' } }));
    const out = await run();

    const row = out.data.roles.find((r) => r.role === 'ghost-role');
    expect(row?.source).toBe('tier-menu');
    expect(row?.model).toBeTruthy();
    expect(row?.backendSource).toBe('model-catalog');
  });

  it('says which population it measured, so a bounded list is never read as complete', async () => {
    readMock.mockResolvedValue(cfg({ models: { mug: 'claude-opus-5:xhigh' } }));

    expect((await run()).data.population).toBe('configured');

    // An UNCONFIGURED role is still answerable by name — that is the whole point
    // of the bounded-population note.
    const asked = await run({ roles: ['kettle'] });
    expect(asked.data.population).toBe('requested');
    expect(asked.data.roles.map((r) => r.role)).toEqual(['kettle']);
  });
});
