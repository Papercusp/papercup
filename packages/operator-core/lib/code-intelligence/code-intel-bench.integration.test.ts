/**
 * P-010 — the bakeoff RUN.
 *
 * Drives the in-operator LSP adapter against the real pinned language servers
 * across the whole probe set and grades every answer on the frozen acceptance
 * corpus. This is where the numbers the routing policy rests on come from, so
 * it is deliberately an integration test: a mocked server would prove only
 * that our translation layer round-trips.
 *
 * Skips — loudly, naming what is missing — when a pinned server is absent,
 * because a silently-green skip is the same false-negative the corpus exists
 * to prevent.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BENCH_PROBES,
  formatLegReport,
  runLspAdapterLeg,
  type LspLegReport,
} from './code-intel-bench.ts';
import { resolveServerBin, shutdownAllLspClients } from './lsp-adapter.ts';
import { DEFAULT_RESOURCE_BUDGET } from './contracts.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const TS_PRESENT = resolveServerBin('typescript') !== null;
const RUST_PRESENT = resolveServerBin('rust') !== null;
const missing = [
  TS_PRESENT ? '' : 'typescript-language-server',
  RUST_PRESENT ? '' : 'rust-analyzer',
].filter(Boolean);

afterAll(async () => {
  await shutdownAllLspClients();
});

describe.skipIf(missing.length > 0)(
  `LSP adapter bakeoff on the frozen corpus${missing.length ? ` — SKIPPED, missing ${missing.join(', ')}` : ''}`,
  () => {
    let report: LspLegReport;

    it(
      'runs every probe cold and grades it against the corpus',
      { timeout: 900_000 },
      async () => {
        report = await runLspAdapterLeg({
          repoRoot: REPO_ROOT,
          cold: true,
          // Sized from the MEASURED cold start (~7.8s for TypeScript on this
          // repo, per lsp-adapter.integration.test.ts), with generous headroom
          // for rust-analyzer's larger crate graph. Still bounded: a probe that
          // has not answered in 90s is not going to.
          // rust-analyzer must run `cargo metadata` and build proc macros for
          // the Tauri crate on a cold start, which is minutes, not seconds.
          deadlineMs: 300_000,
          // The whole leg is bounded too, so one slow probe cannot starve the
          // rest and cost us the entire report.
          legBudgetMs: 600_000,
          pollMs: 500,
        });

        // The report is the deliverable — emit it whatever the assertions do.
        console.log('\n=== P-010 lsp-adapter leg ===\n' + formatLegReport(report) + '\n');

        expect(report.measurements).toHaveLength(BENCH_PROBES.length);
      },
    );

    it('never returns an untrustworthy empty answer', () => {
      // A false-empty is the disqualifying failure: it is indistinguishable
      // from a true "no results" and silently ends an agent's search.
      for (const m of report.measurements) {
        expect(m.trustworthyEmpty, `${m.caseId} produced an untrustworthy empty`).toBe(true);
      }
    });

    it('answers every ground-truth case correctly', () => {
      const wrong = report.measurements.filter((m) => !m.correct);
      expect(
        wrong.map((m) => `${m.caseId}: ${m.grade.reason}${m.error ? ` [${m.error}]` : ''}`),
      ).toEqual([]);
    });

    it('stays inside the per-workspace process budget', () => {
      // childProcMax is 1 PER LANGUAGE workspace; two languages means two
      // servers, which is the shared-server design working as intended.
      expect(report.resources.childProcCount).toBeLessThanOrEqual(2);
      expect(report.resources.withinRssBudget).toBe(true);
    });

    it('meets the warm-query budget once the server is hot', () => {
      const warm = report.measurements
        .map((m) => m.warmQueryMs)
        .filter((v): v is number => v !== null);
      expect(warm.length).toBeGreaterThan(0);
      for (const ms of warm) {
        expect(ms).toBeLessThanOrEqual(DEFAULT_RESOURCE_BUDGET.warmQueryMsMax);
      }
    });
  },
);
