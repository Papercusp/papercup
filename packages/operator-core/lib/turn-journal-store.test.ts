import { afterEach, describe, expect, it, vi } from 'vitest';

const sql = vi.fn();

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));

const { fileWritesSince } = await import('./turn-journal-store');

afterEach(() => {
  sql.mockReset();
});

describe('fileWritesSince (P-015 activity-ledger seam)', () => {
  it('selects native and shell activity rows, then delegates extraction', async () => {
    sql.mockResolvedValue([
      { file: '/home/x/.papercusp/scratch/p006/judge-A-scores.md', command: null },
      { file: null, command: "cat > '/home/x/.papercusp/scratch/p006/judge-B-scores.md' <<'EOF'\n...\nEOF" },
      { file: null, command: "cat '/home/x/.papercusp/scratch/p006/read-only.md'" },
    ]);

    await expect(
      fileWritesSince('session-1', '2026-08-25T00:00:00.000Z'),
    ).resolves.toEqual([
      '/home/x/.papercusp/scratch/p006/judge-A-scores.md',
      '/home/x/.papercusp/scratch/p006/judge-B-scores.md',
    ]);

    const template = sql.mock.calls[0]?.[0] as TemplateStringsArray;
    const query = Array.from(template).join(' ');
    expect(query).toContain("detail->>'file'");
    expect(query).toContain("detail->>'command'");
    expect(query).toContain("summary LIKE '✎%'");
    expect(query).toContain("summary LIKE '▶%'");
  });
});
