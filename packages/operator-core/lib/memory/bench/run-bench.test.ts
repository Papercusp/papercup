/**
 * Runner tests (memory-backend-benchmark P-006) — the claude-file and
 * noop legs run the FULL frozen fixtures end-to-end with no PG and no
 * network, proving the harness mechanics + the D-001 control. The mem0
 * leg needs live PG + an embedder key and is exercised by the recorded
 * P-007 bench run (see bench-cli.ts), not by CI.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  COST_METHODOLOGY,
  costPer1kRemembers,
  costPer1kSearches,
} from './cost-model';
import { runBench, writeBenchReport } from './run-bench';

describe('cost model', () => {
  it('claude-file/noop are free; mem0 paths priced', () => {
    const free = { avgRememberChars: 400, avgSearchChars: 60, extractionOnRemember: false, embeds: false };
    expect(costPer1kRemembers(free)).toBe(0);
    expect(costPer1kSearches(free)).toBe(0);

    // Default (D-005): extraction rides the Claude subscription session at
    // ~$0 marginal, so a live mem0 remember is EMBEDDING-ONLY: 100 tok * $0.02/M.
    const mem0 = { avgRememberChars: 400, avgSearchChars: 60, extractionOnRemember: true, embeds: true };
    const embedOnly = (100 * 0.02) / 1e6;
    expect(costPer1kRemembers(mem0)).toBeCloseTo(embedOnly * 1000, 10);
    // Metered-key FALLBACK rung (extractionMetered:true) is the upper bound:
    // embed 100 tok * $0.02/M + extraction (1800+100)*$0.15/M + 150*$0.6/M.
    const perMetered = (100 * 0.02 + 1900 * 0.15 + 150 * 0.6) / 1e6;
    expect(costPer1kRemembers({ ...mem0, extractionMetered: true })).toBeCloseTo(perMetered * 1000, 10);
    expect(costPer1kSearches(mem0)).toBeCloseTo(((15 * 0.02) / 1e6) * 1000, 10);
    expect(COST_METHODOLOGY).toContain('chars/4');
  });
});

describe('runBench (claude-file + noop, full frozen fixtures)', () => {
  it('produces a scorecard where the control reads zero and the file backend behaves per D-003', async () => {
    const report = await runBench({ backends: ['claude-file', 'noop'] });

    expect(report.corpusSize).toBeGreaterThanOrEqual(110);
    expect(report.goldSize).toBe(150);
    expect(report.cards.map((c) => c.backend)).toEqual(['claude-file', 'noop']);

    const [file, noop] = report.cards;

    // The D-001 control: a no-op scores zero everywhere.
    expect(noop.seedFailed).toBe(report.corpusSize);
    expect(noop.retrieval.overall.p5).toBe(0);
    expect(noop.retrieval.overall.mrr).toBe(0);
    expect(noop.retrieval.byClass['hard-negative']?.fpAt5).toBe(0);
    expect(noop.costPer1kRemembers).toBe(0);

    // The file backend seeds everything and shows the D-003 signature:
    // exact-identifier (grep's home turf) beats lexical-gap (its blind spot).
    expect(file.seedFailed).toBe(0);
    const ei = file.retrieval.byClass['exact-identifier'];
    const lg = file.retrieval.byClass['lexical-gap'];
    expect(ei?.mrr ?? 0).toBeGreaterThan(0.3);
    expect(ei?.mrr ?? 0).toBeGreaterThan(lg?.mrr ?? 0);
    expect(file.costPer1kRemembers).toBe(0);
    expect(file.rememberP50Ms).toBeGreaterThan(0);

    // Durability probes recorded as measured reach rows.
    expect(file.reach?.['measured: 12 concurrent writes']).toBe('12/12 persisted');
    expect(file.reach?.['measured: fresh-instance recall (restart analogue)']).toMatch(/^yes/);

    // One table, both backends, no verdict.
    expect(report.scorecardMarkdown).toContain('**claude-file**');
    expect(report.scorecardMarkdown).toContain('**noop**');
    expect(report.scorecardMarkdown.toLowerCase()).not.toContain('recommend');

    // perQuery carries topText for the T3 judged tier (peer contract).
    const withHits = file.retrieval.perQuery.find((q) => q.rawHits > 0);
    expect(withHits?.topText).toBeTruthy();
  }, 120_000);

  it('writeBenchReport persists json + md artifacts', async () => {
    const report = await runBench({ backends: ['noop'] });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-report-'));
    try {
      const files = writeBenchReport(report, tmp);
      expect(fs.existsSync(files.json)).toBe(true);
      expect(fs.existsSync(files.md)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(files.json, 'utf8'));
      expect(parsed.cards).toHaveLength(1);
      expect(fs.readFileSync(files.md, 'utf8')).toContain('Cost methodology');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);
});
