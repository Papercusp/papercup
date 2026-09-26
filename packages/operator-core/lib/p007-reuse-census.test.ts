import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessP007ReuseCensus,
  P007_CHANGED_FILES,
  P007_CALL_GRAPH_EDGES,
} from './p007-reuse-census';

function checkedOutSources(): Record<string, string> {
  const repoRoot = existsSync(resolve(process.cwd(), 'packages')) ? process.cwd() : resolve(process.cwd(), '../..');
  return Object.fromEntries(
    P007_CHANGED_FILES.map(({ path }) => [path, readFileSync(resolve(repoRoot, path), 'utf8')]),
  );
}

/**
 * Independent oracle for the census inventory (R-006 oracle-independence).
 *
 * Transcribed from the completion evidence recorded on the P-003..P-006 work-items
 * (`payload._completionEvidence.filesChanged` of WI-10000332..WI-10000335, read
 * 2026-09-26) — NOT copied from `P007_CHANGED_FILES`. The census module and this
 * test both claim to describe the same recorded population; if a parallel surface
 * (a new scheduler, monitor, memory store) is appended to the module inventory so
 * the census stops flagging it, this pin fails instead of the census silently
 * widening its own expected set.
 */
const RECORDED_COMPLETION_FILES: Readonly<Record<string, readonly string[]>> = {
  'P-003': [
    'packages/operator-core/lib/agent-config-constants.ts',
    'packages/operator-core/lib/agent-config-constants.test.ts',
    'apps/operator/lib/chat-actions/ContextLimitAction.ts',
    'packages/operator-core/lib/model-context-budget.mjs',
    'packages/operator-core/lib/model-context-budget.d.mts',
    'apps/operator/lib/release/release-instructions.ts',
    'apps/operator/lib/release/release-history-page.test.ts',
    'packages/operator-core/lib/agent-tools/config/set-compaction-limit-core.test.ts',
    'apps/operator/scripts/psu-launcher.mjs',
    'apps/operator/scripts/psu-launcher.d.mts',
  ],
  'P-004': [
    'apps/operator/scripts/psu-pty-host.mjs',
    'apps/operator/scripts/psu-pty-host.d.mts',
    'packages/operator-core/lib/events/await/psu-pty-discovery.ts',
    'packages/operator-core/lib/events/await/wake-executor.ts',
  ],
  'P-005': [
    'packages/operator-core/lib/fleet-repeated-recovery.ts',
    'packages/operator-core/lib/fleet-repeated-recovery.test.ts',
    'packages/operator-core/lib/fleet-repeated-recovery.integration.test.ts',
    'packages/operator-core/lib/fleet-transition-events.ts',
    'packages/operator-core/lib/fleet-transition-events.test.ts',
    'packages/operator-core/lib/harness/routines/fleet-transition-sweep-action.ts',
    'packages/operator-core/lib/harness/routines/fleet-transition-sweep-action.test.ts',
    'packages/operator-core/lib/agent-tools/fleet/leader-brief.ts',
    'packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts',
    'packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts',
    'packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.test.ts',
    'packages/operator-core/lib/events/await/catalog.ts',
    'packages/operator-core/lib/events/await/catalog.test.ts',
    'packages/operator-core/lib/events/await/emitter-pin.ts',
    'packages/operator-core/lib/events/await/emitter-pin.test.ts',
  ],
  'P-006': ['packages/operator-core/lib/acceptance-bar-contract-snapshot.integration.test.ts'],
};

describe('P-007 R-006 reuse/call-graph census', () => {
  it('pins the census inventory to the recorded completion evidence (independent oracle)', () => {
    const byArea: Record<string, string[]> = {};
    for (const { area, path } of P007_CHANGED_FILES) (byArea[area] ??= []).push(path);
    const sorted = (rec: Readonly<Record<string, readonly string[]>>) =>
      Object.fromEntries(Object.keys(rec).sort().map((area) => [area, [...rec[area]!].sort()]));
    expect(sorted(byArea)).toEqual(sorted(RECORDED_COMPLETION_FILES));
  });

  it('covers every recorded P-003..P-006 changed file and existing consumer edge', () => {
    const result = assessP007ReuseCensus(checkedOutSources());
    expect(result).toMatchObject({
      ok: true,
      checkedFiles: P007_CHANGED_FILES.length,
      checkedEdges: P007_CALL_GRAPH_EDGES.length,
      findings: [],
    });
  });

  it('catches a parallel-surface file added outside the completion population', () => {
    const sources = checkedOutSources();
    sources['packages/operator-core/lib/new-scheduler.ts'] = 'export class NewScheduler {}';
    const result = assessP007ReuseCensus(sources);
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: 'unexpected-file',
      path: 'packages/operator-core/lib/new-scheduler.ts',
    }));
  });

  it.each(P007_CALL_GRAPH_EDGES)('catches a deleted required edge: $description', (edge) => {
    const sources = checkedOutSources();
    const original = sources[edge.path]!;
    const mutant = edge.requiredTokens.reduce((text, token) => text.replaceAll(token, ''), original);
    sources[edge.path] = mutant;
    const result = assessP007ReuseCensus(sources);
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ kind: 'missing-edge', path: edge.path, area: edge.area }));
  });
});
