/**
 * plans:get delta capability (agent-tool-delta-client-rollout-2026-06-23, P-002).
 * plans:get returns a single plan's COMPOSITE detail (content + items + decisions), so it
 * opts into not_modified-ONLY: the content-hash revision suppresses an unchanged body, but
 * it must NOT declare a semantic row surface (itemKey/rows) — a row-delta over one sub-field
 * would silently miss the others. This pins that not_modified-only contract.
 */
import { describe, it, expect } from 'vitest';
import tool from './get';

const delta = (tool as unknown as { delta?: import('@papercusp/tooldef').DeltaCapability }).delta;

describe('plans:get delta capability (not_modified-only)', () => {
  it('declares scope + schemaVersion + maxDeltaAge', () => {
    expect(delta).toBeDefined();
    expect(delta!.schemaVersion).toBe('plans-get-v1');
    expect(delta!.maxDeltaAge).toBe(5 * 60_000);
    expect(delta!.scope!({}, { workspaceId: 'ws-3' } as never)).toBe('ws-3');
  });

  it('is not_modified-ONLY — declares NO semantic row surface (composite response)', () => {
    expect(delta!.itemKey).toBeUndefined();
    expect(delta!.rows).toBeUndefined();
    expect(delta!.rowRevision).toBeUndefined();
  });
});
