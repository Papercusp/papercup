/** D-017/P-019 cross-client contract: the deterministic carry boundary is the
 * recovery delivery for Claude, Codex, and OMP. A complete current-generation
 * marker requires zero recovery-orient calls; a failed/incomplete injection
 * requires exactly one fallback. */
import { describe, expect, it } from 'vitest';
import type { CarryBrief } from './carry-brief';
import { buildCarryDoc, type BuildCarryDocOpts, type CarryDoc } from './carry-doc';
import { buildOwnerRespawnLaunchSpec } from './carry-respawn';
import { buildMaintenanceCarrySummary } from './maintenance-carry';
import type { AutomaticCompactionRecovery } from './agent-tools/coordination/compaction-recovery';

const NOW = 1_800_000_000_000;

function brief(): CarryBrief {
  return {
    ownerId: 'su-1',
    loop: {
      harness: 'papercusp',
      active: true,
      intervalSec: 60,
      goal: 'finish P-019',
      carryNote: '## Next\nfinish P-019',
      carryNoteUpdatedAtMs: NOW,
    },
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
  };
}

function automaticRecovery(complete = true): AutomaticCompactionRecovery {
  return {
    marker: {
      schemaVersion: 'post-compaction-recovery-v1',
      complete,
      memoryEpoch: 23,
      controlGeneration: complete ? 17 : null,
      controlStateHash: complete ? 'state-hash-19' : null,
      fallback: {
        verb: 'coord:orient',
        args: { afterCompaction: true },
        when: [
          'marker-absent',
          'marker-incomplete',
          'control-state-mismatch',
          'legacy-control-generation-mismatch',
        ],
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
                items: ['P-019'],
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
      coverage: {
        selfSession: true,
        control: complete,
        heldItems: true,
        staleness: null,
      },
    },
  };
}

function doc(automatic: AutomaticCompactionRecovery | null): CarryDoc {
  return {
    brief: brief(),
    automaticRecovery: automatic,
    identity: {
      ownerId: 'su-1',
      ownerLabel: 'su · su-1',
      harness: 'papercusp',
      workspaceId: 'ws-1',
      fleet: null,
      account: 'default',
    },
    sessionMode: {
      modes: [{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }],
      loopActive: true,
      loopIntervalSec: 60,
      loopGoal: 'finish P-019',
    },
    planItems: [],
    asks: [],
    tail: [],
    continuation: {
      lastOwnerMessage: null,
      answered: true,
      deliberate: true,
      selfRequested: true,
    },
  };
}

function orientCallsRequired(
  rendered: string,
  latestControlGeneration = 17,
  latestControlStateHash: string | null | undefined = 'state-hash-19',
): 0 | 1 {
  const line = rendered.split(/\r?\n/).find((candidate) => candidate.startsWith('⟦post-compaction-recovery⟧ '));
  if (!line) return 1;
  const marker = JSON.parse(line.slice(line.indexOf('{'))) as {
    complete?: boolean;
    controlGeneration?: number | null;
    controlStateHash?: string | null;
  };
  if (!marker.complete) return 1;
  // New CTRL blocks carry the semantic hash. A generation-only activation
  // churn must not force a re-orient when that hash is unchanged.
  if (latestControlStateHash != null) {
    return marker.controlStateHash === latestControlStateHash ? 0 : 1;
  }
  // Legacy CTRL blocks have no hash, so retain the conservative generation
  // fallback for that compatibility path.
  return marker.controlGeneration === latestControlGeneration ? 0 : 1;
}

function fallbackInstructionCount(rendered: string): number {
  return rendered.match(/Call `coord:orient \{ afterCompaction: true \}` exactly once/g)?.length ?? 0;
}

async function renderAcrossClients(carry: CarryDoc) {
  const respawn = async (sourceKind: 'claude' | 'codex') => {
    const buildFn = async (_ownerId: string, opts?: BuildCarryDocOpts) => {
      expect(opts?.transcriptSourceKind).toBe(sourceKind);
      return carry;
    };
    const spec = await buildOwnerRespawnLaunchSpec('su-1', {
      effectiveWindowTokens: 400_000,
      now: NOW,
      buildOpts: { transcriptSourceKind: sourceKind },
      buildFn,
    });
    expect(spec).not.toBeNull();
    return spec!.systemPromptAddendum;
  };
  const ompBuild = async (_ownerId: string, opts?: BuildCarryDocOpts) => {
    expect(opts?.transcriptSourceKind).toBe('omp');
    return carry;
  };
  const omp = await buildMaintenanceCarrySummary('su-1', {
    effectiveWindowTokens: 400_000,
    now: NOW,
    buildOpts: { transcriptSourceKind: 'omp' },
    buildFn: ompBuild,
  });
  expect(omp).not.toBeNull();
  return {
    claude: await respawn('claude'),
    codex: await respawn('codex'),
    omp: omp!.summary,
  };
}

describe('automatic post-compaction recovery — Claude/Codex/OMP parity', () => {
  it('a complete current-generation delivery requires zero recovery-orient calls on every client', async () => {
    const rendered = await renderAcrossClients(doc(automaticRecovery()));
    for (const [client, text] of Object.entries(rendered)) {
      expect(orientCallsRequired(text), client).toBe(0);
      expect(text, client).toContain('"schemaVersion":"post-compaction-recovery-v1"');
      expect(text, client).toContain('"memoryEpoch":23');
      expect(text, client).toContain('"controlGeneration":17');
      expect(text, client).toContain('"controlStateHash":"state-hash-19"');
      expect(text, client).toContain('Do NOT call coord:orient');
      expect(text, client).toContain('coord:declare-intent { intent, current_plan_slug, items }');
    }
  });

  it('a forced automatic-injection failure yields exactly one fallback on every client', async () => {
    const failed = await buildCarryDoc('su-1', {
      workspaceId: 'ws-1',
      harness: 'papercusp',
      buildCarryBriefFn: async () => brief(),
      buildAutomaticRecoveryFn: async () => {
        throw new Error('forced automatic recovery injection failure');
      },
      getModesFn: async () => [],
      getPlanItemsFn: async () => [],
      getAsksFn: async () => [],
      getTailFn: async () => [],
    });
    expect(failed.automaticRecovery).toBeNull();

    const rendered = await renderAcrossClients(failed);
    for (const [client, text] of Object.entries(rendered)) {
      expect(orientCallsRequired(text), client).toBe(1);
      expect(fallbackInstructionCount(text), client).toBe(1);
      expect(text, client).toContain('No automatic recovery marker arrived');
      expect(text, client).not.toContain('Do NOT call coord:orient');
    }
  });

  it('an incomplete marker or changed control state resolves to one fallback, never two', async () => {
    const incomplete = await renderAcrossClients(doc(automaticRecovery(false)));
    for (const [client, text] of Object.entries(incomplete)) {
      expect(orientCallsRequired(text), client).toBe(1);
      expect(fallbackInstructionCount(text), client).toBe(1);
    }

    const activationChurn = await renderAcrossClients(doc(automaticRecovery()));
    for (const [client, text] of Object.entries(activationChurn)) {
      expect(orientCallsRequired(text, 18, 'state-hash-19'), client).toBe(0);
      expect(text, client).toContain('controlStateHash');
    }

    const changedState = await renderAcrossClients(doc(automaticRecovery()));
    for (const [client, text] of Object.entries(changedState)) {
      expect(orientCallsRequired(text, 18, 'state-hash-20'), client).toBe(1);
      expect(text, client).toContain('content-mismatched');
    }
  });
});
