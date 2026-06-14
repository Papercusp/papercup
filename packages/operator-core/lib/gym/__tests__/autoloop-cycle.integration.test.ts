/**
 * autoloop-cycle.integration.test.ts — the gym LIVE-BOOT E2E (the only test that
 * exercises runOneAutoloopCycle end-to-end, not the fake-abDeps wiring shortcut
 * the other gym integration suites use).
 *
 * In FAKE mode (zero LLM) this provisions an ephemeral gym PG (testcontainer),
 * seeds the tiny substrate repo, BOOTS A REAL HEADLESS GYM-OPERATOR, runs one
 * bounded human-gated optimization cycle over the real loop machinery
 * (fake-agent.mjs + fakeJudge + fakeProposer), settles the autoloop row, and
 * tears everything down. It validates the ASSEMBLY the CLI / `system:gym-cycle`
 * routine action run — operator boot + readiness, loop completion, the
 * control-plane autoloop row, the falsifiability pool surfaces — that the
 * fake-abDeps suites can't (they never boot an operator).
 *
 * Heavy + Docker-required: the operator boot alone can take tens of seconds, so
 * the cases carry long timeouts. Zero LLM spend (fake mode).
 */
import { describe, it, expect } from 'vitest';
import { runOneAutoloopCycle, maskDsn } from '../autoloop-cycle';

// A per-process port + slug so a parallel runner (or a live :3070/:3170) never collides.
const PORT = 3900 + (process.pid % 80);
const SLUG = `gymloop-e2e-${process.pid}`;
const BOOT_TIMEOUT_MS = 300_000;

describe('runOneAutoloopCycle — live-boot E2E (fake mode, zero LLM)', () => {
  it(
    'boots a gym-operator, runs one human-gated cycle, and settles the autoloop row',
    async () => {
      const outcome = await runOneAutoloopCycle(SLUG, {
        fake: true,
        port: PORT,
        maxCycles: 1,
        workspaceId: `gymloop-e2e-ws-${process.pid}`,
        manageAutoloopRow: true,
        log: () => {},
      });

      // The whole assembly came up and a cycle completed without tripping the breaker.
      if (!outcome.ok) {
        // Surface the operator boot-log tail so an env failure is diagnosable, not opaque.
        throw new Error(
          `autoloop cycle did not complete: ${maskDsn(JSON.stringify(outcome.report, null, 2))}`,
        );
      }
      expect(outcome.ok).toBe(true);
      expect(outcome.report.mode).toBe('fake (zero-LLM)');

      // The loop ran ≥1 cycle and the arithmetic circuit breaker stayed closed.
      expect(outcome.result).not.toBeNull();
      expect(outcome.result!.cycles).toBeGreaterThanOrEqual(1);
      expect(outcome.result!.breakerTripped).toBe(false);
      // Fake mode is zero-spend.
      expect(outcome.result!.spentUsd).toBe(0);

      // The control-plane autoloop row settled to a terminal status (idle, breaker closed)
      // with the run's spend written back (CLI manageAutoloopRow path).
      const autoloop = outcome.report.autoloop as { status?: string; spentUsd?: number } | undefined;
      expect(autoloop?.status).toBe('idle');

      // The D-014/P-028 falsifiability surfaces are present (train + real-anchor pools
      // scored this cycle) — the report the human review reads.
      expect(outcome.report).toHaveProperty('trainByVariant');
      expect(outcome.report).toHaveProperty('realAnchorByVariant');
    },
    BOOT_TIMEOUT_MS,
  );
});
