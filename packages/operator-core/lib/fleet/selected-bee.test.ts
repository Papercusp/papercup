/**
 * Unit tests for the in-memory selected-bee relay (pui-bee-dossier-pane-2026-06-06).
 *
 *   npx vitest run lib/fleet/selected-bee.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';

import { clearSelectedBee, getSelectedBee, setSelectedBee } from './selected-bee';

afterEach(() => {
  clearSelectedBee('ws1');
  clearSelectedBee('ws2');
  clearSelectedBee(null);
});

describe('selected-bee relay', () => {
  it('unset → null', () => {
    expect(getSelectedBee('ws1')).toBeNull();
  });

  it('set then get round-trips ownerId + name and stamps ts', () => {
    const before = Date.now();
    const entry = setSelectedBee('ws1', 'su-bee', 'forager');
    expect(entry.ownerId).toBe('su-bee');
    expect(entry.name).toBe('forager');
    expect(entry.ts).toBeGreaterThanOrEqual(before);
    expect(getSelectedBee('ws1')).toEqual(entry);
  });

  it('is per-workspace — workspaces do not cross-talk', () => {
    setSelectedBee('ws1', 'su-a');
    setSelectedBee('ws2', 'su-b');
    expect(getSelectedBee('ws1')?.ownerId).toBe('su-a');
    expect(getSelectedBee('ws2')?.ownerId).toBe('su-b');
  });

  it('null/undefined workspace shares one default slot', () => {
    setSelectedBee(null, 'su-default');
    expect(getSelectedBee(undefined)?.ownerId).toBe('su-default');
  });

  it('empty ownerId clears the selection (null owner)', () => {
    setSelectedBee('ws1', 'su-a');
    const cleared = setSelectedBee('ws1', '');
    expect(cleared.ownerId).toBeNull();
    expect(getSelectedBee('ws1')?.ownerId).toBeNull();
  });

  it('latest publish wins', () => {
    setSelectedBee('ws1', 'su-a');
    setSelectedBee('ws1', 'su-b');
    expect(getSelectedBee('ws1')?.ownerId).toBe('su-b');
  });
});
