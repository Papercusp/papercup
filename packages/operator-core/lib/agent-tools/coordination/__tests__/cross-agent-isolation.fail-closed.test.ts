import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(new URL('./cross-agent-isolation.integration.test.ts', import.meta.url)),
  'utf8',
);

describe('cross-agent isolation qualification is fail-closed (WI-42220 / D-004)', () => {
  it('never converts a final real-Postgres readiness failure into skipped isolation suites', () => {
    expect(SOURCE).not.toContain('PG not reachable, skipping');
    expect(SOURCE).not.toMatch(/describeMaybe|describe\.skip|describe\.skipIf/);
    expect(SOURCE).toContain('refusing to convert isolation coverage into a green skip');
    expect(SOURCE).toMatch(/catch \(e\) \{[\s\S]*throw new Error\([\s\S]*\{ cause: e \}/);
  });

  it('keeps all three real-store qualification groups unconditional', () => {
    expect(SOURCE).toContain("describe('coord:send / inbox isolation (real PgCoordLog)'");
    expect(SOURCE).toContain("describe('presence isolation + staleness/revoked (real PgPresenceStore)'");
    expect(SOURCE).toContain("describe('subscribe→inject fan-out isolation (real PG sink)'");
  });
});
