import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'op-recon-'));

vi.mock('./papercusp-root', () => ({
  papercuspPath: (...parts: string[]) => join(tmpRoot, ...parts),
}));
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'test-ws',
}));
// Stub the PG layer — we only exercise the file-merge fallback.
vi.mock('@restart/db-org', () => ({
  withWorkspace: async () => {
    throw new Error('PG unavailable in test');
  },
}));

import { reconstructCards } from './operator-card-reconstruction';

const LAST_SCAN = join(tmpRoot, 'system', 'operator', 'last-scan.json');
const DISMISSED = join(tmpRoot, 'system', 'operator', 'dismissed.json');

beforeEach(() => {
  try {
    rmSync(LAST_SCAN);
  } catch {}
  try {
    rmSync(DISMISSED);
  } catch {}
});

describe('reconstructCards (PG-unavailable fallback)', () => {
  it('returns [] when no last-scan exists', async () => {
    const out = await reconstructCards();
    expect(out).toEqual([]);
  });

  it('hydrates pending from last-scan + dismissed from dismissed.json', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(tmpRoot, 'system', 'operator'), { recursive: true });
    writeFileSync(
      LAST_SCAN,
      JSON.stringify({
        scanCompletedAt: new Date().toISOString(),
        scanCostUsd: 0.05,
        cards: [
          { id: 'c1', title: 'A', action: 'inform' },
          { id: 'c2', title: 'B', action: 'inform' },
        ],
      }),
    );
    writeFileSync(DISMISSED, JSON.stringify([{ id: 'c2', dismissedAt: new Date().toISOString() }]));
    const out = await reconstructCards();
    expect(out).toHaveLength(2);
    expect(out.find((c) => c.id === 'c1')?.status).toBe('pending');
    expect(out.find((c) => c.id === 'c2')?.status).toBe('dismissed');
  });
});
