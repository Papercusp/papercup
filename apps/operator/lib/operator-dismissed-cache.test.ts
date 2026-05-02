import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'op-dismissed-'));
vi.mock('./papercusp-root', () => ({
  papercuspPath: (...parts: string[]) => join(tmpRoot, ...parts),
}));
vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'test-ws',
}));
// PG layer is best-effort; mock it to throw so we exercise the file fallback only.
vi.mock('@restart/db-org', () => ({
  withWorkspace: async () => {
    throw new Error('PG unavailable in test');
  },
}));

import { recordDismissed, isOnCooldown, listDismissed } from './operator-dismissed-cache';

const PATH = join(tmpRoot, 'system', 'operator', 'dismissed.json');

beforeEach(() => {
  if (existsSync(PATH)) rmSync(PATH);
});
afterEach(() => {
  if (existsSync(PATH)) rmSync(PATH);
});

describe('dismissed-cache (file fallback)', () => {
  it('records and detects cooldown', () => {
    expect(isOnCooldown('a')).toBe(false);
    recordDismissed('a');
    expect(isOnCooldown('a')).toBe(true);
  });

  it('does not affect other ids', () => {
    recordDismissed('a');
    expect(isOnCooldown('b')).toBe(false);
  });

  it('expires past the configured cooldown window', () => {
    recordDismissed('a');
    expect(isOnCooldown('a', 0)).toBe(false); // 0ms window
  });

  it('listDismissed returns the recorded entries', () => {
    recordDismissed('a');
    recordDismissed('b');
    const out = listDismissed();
    expect(out.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });
});
