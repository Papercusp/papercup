import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory PG mock — model harness_shared.operator_dismissed_cards as a
// Map<cardId, dismissedAt> keyed under one workspace. Tagged-template
// matcher pattern-matches on the SQL text the implementation actually
// emits and routes to insert/select/list.
const store = new Map<string, string>(); // card_id -> ISO

vi.mock('./workspace-registry', () => ({
  activeWorkspaceId: () => 'test-ws',
}));

vi.mock('@papercusp/db-org', () => {
  function tagged(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> {
    const sqlText = strings.join('?');
    if (/INSERT INTO harness_shared\.operator_dismissed_cards/.test(sqlText)) {
      const cardId = values[1] as string;
      store.set(cardId, new Date().toISOString());
      return Promise.resolve([]);
    }
    if (/SELECT dismissed_at::text/.test(sqlText) && /WHERE workspace_id = .* AND card_id = /.test(sqlText)) {
      const cardId = values[1] as string;
      const at = store.get(cardId);
      return Promise.resolve(at ? [{ dismissed_at: at }] : []);
    }
    if (/SELECT card_id, dismissed_at::text/.test(sqlText)) {
      const out: { card_id: string; dismissed_at: string }[] = [];
      for (const [card_id, dismissed_at] of store) out.push({ card_id, dismissed_at });
      out.sort((a, b) => b.dismissed_at.localeCompare(a.dismissed_at));
      return Promise.resolve(out);
    }
    return Promise.resolve([]);
  }
  return {
    withWorkspace: async (_ws: string, cb: (tx: typeof tagged) => Promise<unknown>) => cb(tagged),
  };
});

import { recordDismissed, isOnCooldown, listDismissed } from './operator-dismissed-cache';

beforeEach(() => {
  store.clear();
});
afterEach(() => {
  store.clear();
});

describe('dismissed-cache (PG-backed)', () => {
  it('records and detects cooldown', async () => {
    expect(await isOnCooldown('a')).toBe(false);
    await recordDismissed('a');
    expect(await isOnCooldown('a')).toBe(true);
  });

  it('does not affect other ids', async () => {
    await recordDismissed('a');
    expect(await isOnCooldown('b')).toBe(false);
  });

  it('expires past the configured cooldown window', async () => {
    await recordDismissed('a');
    expect(await isOnCooldown('a', 0)).toBe(false); // 0ms window
  });

  it('listDismissed returns the recorded entries', async () => {
    await recordDismissed('a');
    await recordDismissed('b');
    const out = await listDismissed();
    expect(out.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });
});
