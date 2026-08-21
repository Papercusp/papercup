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
  KNOWN_DIVERGENCES,
  classifyDivergence,
  formatLegReport,
  runLspAdapterLeg,
  type BenchMeasurement,
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

    it('answers every ground-truth case correctly, or diverges only where accounted', () => {
      // NOT loosened to "3 of 4 pass". Every failure must be an ACCOUNTED
      // divergence — one whose missing sites are exactly the documented
      // unreachable ones AND whose case property still holds. Anything else
      // is a real failure and still fails here, including a NEW way for an
      // already-accounted case to break.
      const unaccounted = report.measurements
        .filter((m) => !m.correct)
        .map((m) => ({ m, verdict: classifyDivergence(m) }))
        .filter(({ verdict }) => !verdict.accounted);

      expect(
        unaccounted.map(
          ({ m, verdict }) =>
            `${m.caseId}: ${m.grade.reason}${m.error ? ` [${m.error}]` : ''} — ${verdict.reason}`,
        ),
      ).toEqual([]);
    });

    it('diverges from the corpus on exactly the accounted cases — no more, no fewer', () => {
      // The set is pinned in BOTH directions on purpose. Growing it silently
      // is how a regression hides; SHRINKING it silently means a divergence
      // got fixed and the accounting entry is now stale prose claiming a
      // limitation the backend no longer has.
      const diverged = report.measurements
        .filter((m) => !m.correct && classifyDivergence(m).accounted)
        .map((m) => m.caseId)
        .sort();

      expect(diverged).toEqual(KNOWN_DIVERGENCES.map((d) => d.caseId).sort());
    });

    it('never returns a reference set that stops at the barrel re-export', () => {
      // Corpus case 2's own falsifier, asserted DIRECTLY rather than through
      // its expected-site list: the danger is a set that never reaches
      // consumers importing through the barrel. Graded here so the property
      // is tested even though the site list is unreachable.
      const m = report.measurements.find(
        (x) => x.caseId === 'references-through-barrel-reexport',
      );
      expect(m, 'the barrel-reexport case was not measured').toBeDefined();
      const consumers = (m as BenchMeasurement).returnedSites.filter(
        (s) => !s.startsWith('libs/generic/dock-workbench/src/'),
      );
      expect(
        consumers.length,
        `reference set reached no consumer outside the declaring package: ` +
          `[${(m as BenchMeasurement).returnedSites.join(', ')}]`,
      ).toBeGreaterThan(0);
    });

    it('returns the declaration in a references answer', () => {
      // Regression guard for the includeDeclaration:false defect: a symbol
      // referenced only at its declaration used to come back as a healthy
      // EMPTY set, which isTrustworthyEmpty blessed as "nothing uses this".
      const m = report.measurements.find(
        (x) => x.caseId === 'references-through-barrel-reexport',
      );
      expect((m as BenchMeasurement).returnedSites).toContain(
        'libs/generic/dock-workbench/src/panel-registry.ts:30',
      );
    });

    it('stays inside the per-process resource budget', () => {
      // childProcMax is 1 PER LANGUAGE workspace; two languages means two
      // servers, which is the shared-server design working as intended.
      expect(report.resources.childProcCount).toBeLessThanOrEqual(2);
      // Graded PER PROCESS — ResourceBudget documents itself "per backend
      // process". Summing two languages and comparing to a one-process
      // ceiling graded the shared-server design as a breach.
      expect(
        report.resources.overBudgetClients,
        `server(s) over the ${DEFAULT_RESOURCE_BUDGET.rssMbMax}MB per-process ceiling`,
      ).toEqual([]);
    });

    it('meets the warm-query budget once the server is hot', () => {
      // Asserted on the MEDIAN of repeated samples: a single re-query lands
      // while the server is still finishing post-answer indexing, and that
      // one sample is not the steady state the routing policy budgets.
      const warm = report.measurements
        .filter((m) => m.warmQueryMs !== null)
        .map((m) => ({ caseId: m.caseId, ms: m.warmQueryMs as number }));
      expect(warm.length).toBeGreaterThan(0);
      expect(
        warm
          .filter(({ ms }) => ms > DEFAULT_RESOURCE_BUDGET.warmQueryMsMax)
          .map(({ caseId, ms }) => `${caseId}: median warm ${ms}ms`),
      ).toEqual([]);
    });
  },
);
