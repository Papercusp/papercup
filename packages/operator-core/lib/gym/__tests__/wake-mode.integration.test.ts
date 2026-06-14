/**
 * wake-mode.integration.test.ts — the gym AUTONOMOUS-CHAIN live-boot E2E
 * (hive-loop-e2e-testing-2026-06-10 P-006). The only test that exercises the
 * full autonomous trigger chain on a real booted operator: the blueprint's
 * `triggers.schedule` → materialized routine → routinesTick fires
 * `system:blueprint-run` → the fire-gate fires the spine decider → the
 * orchestrator sweep runs the pipeline director→worker→validator to DONE → the
 * finalizer fires once. Nothing is manually started — the loop self-drives.
 *
 * FAKE mode (zero LLM): fixtures/fake-wake-agent.mjs walks the spine + records a
 * passing validator verdict so the autoloop converges. wake-mode.test.ts covers
 * the PURE oracle/blueprint/judge helpers; this pins the live wiring they can't.
 *
 * Heavy + Docker-required: boots a real gym-operator with the autoloop ON and
 * waits for the cron-driven chain to settle, so the case carries a long timeout.
 */
import { describe, it, expect } from 'vitest';
import { runGymWakeMode } from '../wake-mode';

// Per-process port + slug so a parallel runner / a live :3070-:3170 never collide.
const PORT = 4100 + (process.pid % 50);
const SLUG = `wakehivee2e${process.pid % 1000}`;
const TIMEOUT_MS = 360_000;

describe('runGymWakeMode — autonomous-chain live-boot E2E (fake mode, zero LLM)', () => {
  it(
    'self-drives one queued feature to passed via the trigger→fire→sweep→pipeline chain',
    async () => {
      const out = await runGymWakeMode({
        fake: true,
        port: PORT,
        slug: SLUG,
        workspaceId: `wake-e2e-ws-${process.pid}`,
        featureCount: 1, // the autonomous chain is the coverage; one feature keeps the run bounded
        timeoutMin: 5,
        log: () => {},
      });

      if (!out.ok) {
        const failures = (out.report.failures as string[] | undefined)?.join('; ') ?? out.report.error;
        throw new Error(`wake-mode chain did not converge: ${failures}\n--- op log tail ---\n${out.report.operatorLogTail ?? ''}`);
      }
      expect(out.ok).toBe(true);
      expect(out.report.mode).toBe('fake (zero-LLM)');
      expect(out.evidence).not.toBeNull();
      const ev = out.evidence!;

      // Liveness: the queued feature reached `passed` via an autonomous pipeline (never manually started).
      expect(ev.features.every((f) => f.status === 'passed')).toBe(true);
      expect(ev.pipelines.some((p) => p.status === 'SUCCESS')).toBe(true);

      // Trigger chain (links 1–2): the loop self-started — routine materialized + fired, decider fired.
      expect(ev.routineSeeded).toBe(true);
      expect(ev.routineFireRuns).toBeGreaterThanOrEqual(1);
      expect(ev.deciderFires.length).toBeGreaterThan(0);

      // Safety: the finalizer ran exactly once per pipeline; no decide-turn ran past the ceiling.
      for (const n of Object.values(ev.finalizeStepsByPipeline)) expect(n).toBe(1);
      for (const n of Object.values(ev.decideStepsByPipeline)) expect(n).toBeLessThanOrEqual(ev.maxTurns);

      // Resources + hygiene: never exceeded the concurrency cap; nothing left running after settle.
      expect(ev.maxConcurrentPipelines).toBeLessThanOrEqual(ev.cap);
      expect(ev.runningRunOutputRows).toBe(0);
      expect(ev.runningNurseryRows).toBe(0);
    },
    TIMEOUT_MS,
  );
});
