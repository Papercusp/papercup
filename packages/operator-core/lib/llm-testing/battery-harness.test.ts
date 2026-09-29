import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { llmBatteryEvidenceRoot, runScenarioBattery, scenarioPhaseOutcome } from './battery-harness';

const scenarios = [
  { id: 'op-S01-a', target: 'operator', description: 'first' },
  { id: 'op-S02-b', target: 'operator', description: 'second' },
  { id: 'su-S03-c', target: 'su', description: 'third' },
];

describe('LLM scenario battery on the verification-harness contract', () => {
  it('one phase per scenario, never-abort, evidence per scenario, outcomes in scenario order', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'llm-battery-'));
    const { outcomes, harness, summaryLine } = await runScenarioBattery({
      scenarios,
      concurrency: 2,
      evidenceRoot: root,
      runScenario: async (s, dir) => {
        writeFileSync(path.join(dir, 'report-summary.json'), JSON.stringify({ id: s.id }));
        return s.id === 'op-S02-b' ? 'failed' : s.id === 'su-S03-c' ? 'skipped' : 'executed';
      },
    });
    expect(outcomes).toEqual(['executed', 'failed', 'skipped']);
    expect(harness.phases.map((p) => [p.phase, p.status, p.reasonCode])).toEqual([
      ['op-S01-a', 'passed', null],
      ['op-S02-b', 'failed', 'scenario-failed'],
      ['su-S03-c', 'failed', 'claim-busy'],
    ]);
    expect(summaryLine).toMatch(/^HARNESS_RESULT harness=llm-scenario-battery verdict=fail .*first_failure=op-S02-b\/run-scenario\/scenario-failed/);
    const kept = JSON.parse(readFileSync(path.join(root, 'latest', 'phases', 'op-S01-a', 'report-summary.json'), 'utf8'));
    expect(kept).toEqual({ id: 'op-S01-a' });
  });

  it('a scenario whose runner throws is a failed phase and a failed outcome, never a pass', async () => {
    const { outcomes, harness } = await runScenarioBattery({
      scenarios: scenarios.slice(0, 1),
      concurrency: 1,
      evidenceRoot: mkdtempSync(path.join(tmpdir(), 'llm-battery-')),
      runScenario: async () => {
        throw new Error('gateway down');
      },
    });
    expect(outcomes).toEqual(['failed']);
    expect(harness.verdict).toBe('fail');
  });

  it('claim-busy is not a pass, and LLM_TEST_EVIDENCE_ROOT overrides the shared default root', () => {
    expect(scenarioPhaseOutcome('skipped')).toMatchObject({ ok: false, reasonCode: 'claim-busy' });
    expect(scenarioPhaseOutcome('executed')).toEqual({ ok: true });
    expect(llmBatteryEvidenceRoot({ LLM_TEST_EVIDENCE_ROOT: '/x/y' })).toBe('/x/y');
    expect(llmBatteryEvidenceRoot({ VH_EVIDENCE_ROOT_BASE: '/base' })).toBe('/base/llm-scenario-battery');
    expect(llmBatteryEvidenceRoot({ HOME: '/h' })).toBe('/h/.local/state/verification-harness/llm-scenario-battery');
  });
});
