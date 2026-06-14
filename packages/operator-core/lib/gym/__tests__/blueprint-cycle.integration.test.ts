/**
 * blueprint-cycle.integration.test.ts — the gym-as-a-BLUEPRINT live-boot E2E
 * (Brief 48). Where autoloop-cycle.integration.test.ts exercises the bespoke
 * optimization loop, this drives ONE gym cycle THROUGH THE DURABLE PIPELINE
 * (deriveNext over the gym spine, D-022) on a real booted operator: a registered
 * harness whose `.papercusp/blueprint.yaml` extends `gym` is resolved from disk,
 * a G- work item binds, and the gym-director's verbs dispatch the gym spine
 * (gym-director → task-generator → variant-runner → judge → proposer → committer)
 * to a SUCCESS workflow.
 *
 * FAKE mode (zero LLM): fixtures/fake-gym-agent.mjs walks the spine verbs. Heavy +
 * Docker-required (boots a real operator + runs a durable pipeline), so the case
 * carries a long timeout.
 */
import { describe, it, expect } from 'vitest';
import { runGymBlueprintCycle } from '../blueprint-cycle';

// Per-process port + slugs so a parallel runner / a live :3070-:3170 never collide.
const PORT = 4200 + (process.pid % 50);
const SUFFIX = process.pid % 1000;
const TIMEOUT_MS = 480_000;

describe('runGymBlueprintCycle — gym-blueprint durable-pipeline live-boot E2E (fake mode, zero LLM)', () => {
  it(
    'resolves the gym spine from a registered harness and walks it to a SUCCESS pipeline',
    async () => {
      const out = await runGymBlueprintCycle({
        fake: true,
        port: PORT,
        workspaceId: `gym-bp-e2e-ws-${SUFFIX}`,
        gymSlug: `g48gym${SUFFIX}`,
        targetSlug: `g48target${SUFFIX}`,
        timeoutMin: 6,
        log: () => {},
      });

      if (!out.ok) {
        throw new Error(
          `gym-blueprint cycle did not complete: ${out.report.error ?? JSON.stringify({
            workflowStatus: out.report.workflowStatus,
            spineWalked: out.report.spineWalked,
            dispatchSequence: out.report.dispatchSequence,
          })}\n--- op log tail ---\n${out.report.operatorLogTail ?? ''}`,
        );
      }
      expect(out.ok).toBe(true);
      expect(out.report.mode).toBe('fake (zero-LLM)');

      // The durable pipeline reached SUCCESS.
      expect(out.report.workflowStatus).toBe('SUCCESS');

      // The FULL gym spine dispatched in order (the unique coverage vs the bespoke loop).
      expect(out.report.spineWalked).toBe(true);
      const seq = out.report.dispatchSequence as string[];
      for (const role of ['gym-director', 'task-generator', 'variant-runner', 'judge', 'proposer', 'committer']) {
        expect(seq.some((r) => r.startsWith(role))).toBe(true);
      }

      // The gym-task work item reached a terminal state.
      expect(out.report.featureStatus).toBeTruthy();
    },
    TIMEOUT_MS,
  );
});
