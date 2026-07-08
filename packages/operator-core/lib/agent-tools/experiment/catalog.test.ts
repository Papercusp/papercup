/**
 * catalog.test.ts — handler-level tests for experiment:catalog (G7).
 *
 * Pure (no PG/LLM): the handler just registers the four descriptors and applies
 * the kind/tier filters over listTests(). Same minimal-ctx idiom as
 * blueprint-catalog.test.ts. The registry is module-global, so we reset both the
 * eval-battery registry AND the operator-side idempotency latch per test so the
 * filter assertions are exact (cf. descriptors.test.ts).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestRegistry } from '@papercusp/eval-battery';
import catalogTool from './catalog';
import { _resetExperimentRegistration } from '../../experiment/descriptors';

const CTX = { log() {}, workspaceId: 'ws', role: 'operator' } as never;

type Entry = { id: string; kind: string; fidelityTier: string; metrics: { rubricRef?: string } };
const run = async (args: Record<string, unknown> = {}): Promise<{ ok: boolean; count: number; tests: Entry[] }> =>
  JSON.parse(
    (
      await (catalogTool as unknown as { handler: (a: never, c: never) => Promise<{ content: { text: string }[] }> }).handler(
        args as never,
        CTX,
      )
    ).content[0].text,
  );

describe('experiment:catalog', () => {
  beforeEach(() => {
    resetTestRegistry();
    _resetExperimentRegistration();
  });

  it('no filter lists all four registered tests', async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.count).toBe(4);
    expect(r.count).toBe(r.tests.length);
    expect(r.tests.map((t) => t.id).sort()).toEqual(['gym', 'hive', 'instance', 'replay']);
    expect(r.tests.find((t) => t.id === 'replay')?.metrics.rubricRef).toBe('experiment-replay-quality');
  });

  it('kind:replay narrows to only the replay test', async () => {
    const r = await run({ kind: 'replay' });
    expect(r.tests.map((t) => t.id)).toEqual(['replay']);
    expect(r.tests.every((t) => t.kind === 'replay')).toBe(true);
    expect(r.count).toBe(1);
  });

  it('tier:live narrows to the three live-spend tiers (gym/instance/hive), excluding offline replay', async () => {
    const r = await run({ tier: 'live' });
    expect(r.tests.map((t) => t.id).sort()).toEqual(['gym', 'hive', 'instance']);
    expect(r.tests.every((t) => t.fidelityTier === 'live')).toBe(true);
    expect(r.tests.some((t) => t.id === 'replay')).toBe(false);
  });

  it('kind:replay + tier:live is empty — replay is offline, never live', async () => {
    const r = await run({ kind: 'replay', tier: 'live' });
    expect(r.ok).toBe(true);
    expect(r.count).toBe(0);
    expect(r.tests).toEqual([]);
  });
});
