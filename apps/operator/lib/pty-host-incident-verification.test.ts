import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Fixed by WI-10003045's diagnosed incident census. Keep this list independent
// of the report so deleting a row cannot shrink the expected population.
const DIAGNOSED_CLASS_IDS = [
  'PTY-SUBMIT-MARKER',
  'PTY-WAKE-REARM',
  'PTY-HOME-RECOVERY',
  'PTY-STARTUP-MENU',
  'PTY-CARRY-FIRST-TURN',
] as const;

const REPORT = process.env.PTY_INCIDENT_REPORT_PATH ?? join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..',
  'scratchpad',
  'pty-host-incident-verification-2026-09-25.md',
);

function reportCoverage(report: string): { missing: string[]; unexpected: string[]; incomplete: string[] } {
  const section = report.match(/## Census and diagnosed behavior\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? '';
  const rows = [...section.matchAll(/^\| `(PTY-[A-Z-]+)` \| ([^\n]+)$/gm)]
    .map((match) => ({ id: match[1], cells: match[2].split(' | ') }));
  const ids = rows.map((row) => row.id);
  return {
    missing: DIAGNOSED_CLASS_IDS.filter((id) => !ids.includes(id)),
    unexpected: ids.filter((id) => !DIAGNOSED_CLASS_IDS.includes(id as typeof DIAGNOSED_CLASS_IDS[number]) || ids.filter((other) => other === id).length > 1),
    incomplete: rows.filter((row) => row.cells.length !== 3 || row.cells.some((cell) => cell.trim().length === 0) || !/\brun \d+\b/.test(row.cells[2] ?? '')).map((row) => row.id),
  };
}

describe('PTY incident verification report coverage', () => {
  const report = readFileSync(REPORT, 'utf8');

  it('records a measured current-build outcome for every diagnosed class', () => {
    expect(reportCoverage(report)).toEqual({ missing: [], unexpected: [], incomplete: [] });
  });

  it('detects a missing diagnosed class in the report', () => {
    const removed = report.replace(/^\| `PTY-WAKE-REARM` \|.*\n/m, '');
    expect(removed).not.toBe(report);
    expect(reportCoverage(removed).missing).toContain('PTY-WAKE-REARM');
  });
});
