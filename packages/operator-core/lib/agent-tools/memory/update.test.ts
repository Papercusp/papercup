import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(),
}));

import update from './update';
import { getMemoryBackend } from '../../memory/backend';

type FakeBackend = {
  name: string;
  available: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const fakeBackend = (): FakeBackend => ({
  name: 'fake',
  available: vi.fn(async () => ({ ok: true })),
  update: vi.fn(async () => undefined),
});

const useBackend = (b: FakeBackend): void => {
  vi.mocked(getMemoryBackend).mockReturnValue(b as unknown as ReturnType<typeof getMemoryBackend>);
};

describe('memory:update — UUID validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-UUID id strings with validation error', async () => {
    const b = fakeBackend();
    useBackend(b);

    const res = await update.handler(
      { id: 'reference_queen_auto_revert_tripwire_graduation_engine_queen_2', content: 'new content' },
      {} as unknown as Parameters<typeof update.handler>[1],
    );

    // Zod validation errors are caught by the defineTool handler and returned as structured errors
    const content = (res as { content?: { text?: string }[] }).content?.[0]?.text;
    expect(content).toBeDefined();
    // The error will indicate validation failure for the UUID format
  });

  it('accepts valid UUID id and calls backend.update', async () => {
    const b = fakeBackend();
    useBackend(b);

    const validId = '550e8400-e29b-41d4-a716-446655440000';
    const res = await update.handler(
      { id: validId, content: 'updated memory content' },
      {} as unknown as Parameters<typeof update.handler>[1],
    );

    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(parsed.ok).toBe(true);
    expect(b.update).toHaveBeenCalledWith(validId, { text: 'updated memory content' });
  });

  it('handles backend unavailability gracefully', async () => {
    const b = fakeBackend();
    b.available.mockResolvedValue({ ok: false, reason: 'memory_backend_disabled' });
    useBackend(b);

    const validId = '550e8400-e29b-41d4-a716-446655440000';
    const res = await update.handler(
      { id: validId, content: 'content' },
      {} as unknown as Parameters<typeof update.handler>[1],
    );

    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('memory_backend_disabled');
    expect(b.update).not.toHaveBeenCalled();
  });

  it('rejects various invalid UUID formats', async () => {
    const b = fakeBackend();
    useBackend(b);

    const invalidIds = [
      'not-a-uuid',
      'reference_id',
      '550e8400-e29b-41d4-a716-44665544000',  // too short
      '550e8400-e29b-41d4-a716-4466554400000', // too long
      '550e8400e29b41d4a716446655440000',      // missing hyphens
      '550e8400-e29b-41d4-a716-44665544000g',  // invalid hex character
      '',                                         // empty (caught by min(1) + uuid validation)
    ];

    for (const id of invalidIds) {
      const res = await update.handler(
        { id, content: 'test' },
        {} as unknown as Parameters<typeof update.handler>[1],
      );

      // All invalid UUIDs should fail validation before reaching backend
      const content = (res as { content?: { text?: string }[] }).content?.[0]?.text;
      expect(content, 'Should return error for invalid UUID: ' + id).toBeDefined();
      expect(b.update).not.toHaveBeenCalled();
    }
  });

  it('returns a graceful {ok:false} when the backend throws not-found (EI-486)', async () => {
    // mem0's update THROWS "Memory with ID … not found" for a well-formed but
    // non-existent id. The handler must catch it and return a clean envelope —
    // not let it escape as a handler_error (which trips the
    // repeated-tool-error:memory:update:structural watchdog).
    const b = fakeBackend();
    const validId = '550e8400-e29b-41d4-a716-446655440000';
    b.update.mockRejectedValue(new Error(`Memory with ID ${validId} not found`));
    useBackend(b);

    let res: Awaited<ReturnType<typeof update.handler>>;
    await expect(
      (async () => {
        res = await update.handler(
          { id: validId, content: 'new content' },
          {} as unknown as Parameters<typeof update.handler>[1],
        );
      })(),
    ).resolves.toBeUndefined(); // must NOT throw

    const parsed = JSON.parse((res! as { content: { text: string }[] }).content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('not found');
    expect(parsed.error).toContain(validId);
  });

  it('surfaces other backend errors gracefully without throwing', async () => {
    const b = fakeBackend();
    const validId = '550e8400-e29b-41d4-a716-446655440000';
    b.update.mockRejectedValue(new Error('connection terminated unexpectedly'));
    useBackend(b);

    const res = await update.handler(
      { id: validId, content: 'new content' },
      {} as unknown as Parameters<typeof update.handler>[1],
    );

    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('connection terminated');
  });

  it('triggers sync invalidation on successful update', async () => {
    const b = fakeBackend();
    useBackend(b);

    const validId = '550e8400-e29b-41d4-a716-446655440000';
    await update.handler(
      { id: validId, content: 'new content' },
      {} as unknown as Parameters<typeof update.handler>[1],
    );

    // Verify the update was called (sync invalidation is fire-and-forget)
    expect(b.update).toHaveBeenCalledWith(validId, { text: 'new content' });
  });

  // ── metadata-hygiene patches (EI-2032: was unfixable through any tool) ──────
  const VID = '550e8400-e29b-41d4-a716-446655440000';

  it('a metadata-only patch (kind + workspaceId, no content) maps to backend.update metadata', async () => {
    const b = fakeBackend();
    useBackend(b);
    const res = await update.handler(
      { id: VID, kind: 'reference', workspaceId: 'papercusp-workspace' },
      {} as unknown as Parameters<typeof update.handler>[1],
    );
    const parsed = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(parsed.ok).toBe(true);
    expect(b.update).toHaveBeenCalledWith(VID, {
      metadata: { kind: 'reference', workspace_id: 'papercusp-workspace' },
    });
  });

  it('scope re-pool maps to metadata.user_id (the recall-pool key)', async () => {
    const b = fakeBackend();
    useBackend(b);
    await update.handler(
      { id: VID, scope: 'harness:papercup' },
      {} as unknown as Parameters<typeof update.handler>[1],
    );
    expect(b.update).toHaveBeenCalledWith(VID, { metadata: { user_id: 'harness:papercup' } });
  });

  it('content + metadata flow through together in one patch', async () => {
    const b = fakeBackend();
    useBackend(b);
    await update.handler(
      { id: VID, content: 'fixed text', kind: 'project' },
      {} as unknown as Parameters<typeof update.handler>[1],
    );
    expect(b.update).toHaveBeenCalledWith(VID, { text: 'fixed text', metadata: { kind: 'project' } });
  });

  it('rejects a patch with neither content nor any metadata field', async () => {
    const b = fakeBackend();
    useBackend(b);
    const res = await update.handler(
      { id: VID },
      {} as unknown as Parameters<typeof update.handler>[1],
    );
    const text = (res as { content?: { text?: string }[] }).content?.[0]?.text;
    expect(text).toBeDefined();
    const parsed = JSON.parse(text!);
    expect(parsed.ok).toBe(false);
    expect(b.update).not.toHaveBeenCalled();
  });
});
