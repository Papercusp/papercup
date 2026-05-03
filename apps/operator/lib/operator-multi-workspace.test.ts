import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `vi.hoisted` runs BEFORE the auto-hoisted vi.mock + import statements,
// so the env var the mock reads is already set when the module loads.
const { tmpRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'op-multi-ws-'));
  process.env.OP_MULTI_TEST_HOME = root;
  return { tmpRoot: root };
});

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>();
  return {
    ...real,
    homedir: () => process.env.OP_MULTI_TEST_HOME ?? real.homedir(),
  };
});

vi.mock('./workspace-registry', () => ({
  readRegistry: () => ({
    current: 'alpha',
    workspaces: [
      { id: 'alpha', name: 'Alpha', createdAt: 0 },
      { id: 'beta', name: 'Beta', createdAt: 0 },
      { id: 'gamma', name: 'Gamma', createdAt: 0 },
    ],
  }),
  activeWorkspaceId: () => 'alpha',
}));

import { readMultiWorkspaceSnapshot } from './operator-multi-workspace';

function seedWorkspace(id: string, lastScan: object | null, dismissed: { id: string; dismissedAt: string }[] = []) {
  const opDir = join(tmpRoot, '.papercusp-workspaces', id, '.papercusp', 'system', 'operator');
  mkdirSync(opDir, { recursive: true });
  if (lastScan) writeFileSync(join(opDir, 'last-scan.json'), JSON.stringify(lastScan));
  if (dismissed.length) writeFileSync(join(opDir, 'dismissed.json'), JSON.stringify(dismissed));
}

afterEach(() => {
  try {
    rmSync(join(tmpRoot, '.papercusp-workspaces'), { recursive: true, force: true });
  } catch {}
});

describe('readMultiWorkspaceSnapshot', () => {
  it('omits the active workspace from the aggregation', () => {
    seedWorkspace('alpha', { cards: [{ id: '1', title: 'A1' }] });
    seedWorkspace('beta', { cards: [{ id: '2', title: 'B1' }] });
    const snap = readMultiWorkspaceSnapshot('alpha');
    expect(snap.workspaces.map((w) => w.id).sort()).toEqual(['beta', 'gamma']);
    expect(snap.cards.find((c) => c.workspaceId === 'alpha')).toBeUndefined();
  });

  it('flags dismissed cards', () => {
    seedWorkspace(
      'beta',
      { cards: [{ id: '1', title: 'kept' }, { id: '2', title: 'dismissed' }] },
      [{ id: '2', dismissedAt: new Date().toISOString() }],
    );
    const snap = readMultiWorkspaceSnapshot('alpha');
    const beta = snap.cards.filter((c) => c.workspaceId === 'beta');
    expect(beta).toHaveLength(2);
    expect(beta.find((c) => c.card.id === '1')?.dismissed).toBe(false);
    expect(beta.find((c) => c.card.id === '2')?.dismissed).toBe(true);
  });

  it('returns empty card list when a workspace has no scan yet', () => {
    seedWorkspace('beta', null);
    const snap = readMultiWorkspaceSnapshot('alpha');
    const beta = snap.workspaces.find((w) => w.id === 'beta');
    expect(beta?.cardCount).toBe(0);
    expect(beta?.scanCompletedAt).toBeNull();
  });

  it('drops non-object card entries silently', () => {
    seedWorkspace('beta', { cards: [null, 5, 'x', { id: 'good', title: 'G' }] });
    const snap = readMultiWorkspaceSnapshot('alpha');
    const beta = snap.cards.filter((c) => c.workspaceId === 'beta');
    expect(beta).toHaveLength(1);
    expect(beta[0].card.id).toBe('good');
  });
});
