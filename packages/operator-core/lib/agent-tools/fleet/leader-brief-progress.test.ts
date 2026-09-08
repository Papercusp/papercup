import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentClaim } from '../../fleet/assignments';
import { renderCarryBriefText, type CarryBrief, type CarryBriefHeldItem } from '../../carry-brief';
import { renderCarryDoc, type CarryDoc } from '../../carry-doc';
import { shortCarryHash, withCarryNoteChecks, withCarryNoteWalls } from '../../carry-note';
import {
  LEADER_PROGRESS_ITEM_LIMIT, LEADER_PROGRESS_MEMBER_LIMIT, LEADER_PROGRESS_TEXT_LIMIT,
  readLeaderCheckpointProgress,
} from './leader-brief-progress';

const ws = 'checkpoint-fixture-workspace';
const owner = 'checkpoint-fixture-owner';
const now = Date.parse('2026-09-08T19:00:00Z');
const claim = (id = 'WI-A', harnessSlug: string | null = 'fixture'): AgentClaim => ({
  type: 'work-item', id, harnessSlug, active: true,
} as AgentClaim);
const member = (agentId = owner, claims = [claim()]) => ({ agentId, claims });
const held = (note: string | null, id = 'WI-A'): CarryBriefHeldItem => ({
  id, harness: 'fixture', title: id, body: null, checkpoint: note,
  checkpointUpdatedAtMs: now, lastProgressAtMs: now,
  holderProof: { ownerId: owner, workspaceId: ws },
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('leader canonical checkpoint progress projection (P-005)', () => {
  it('derives leader and carry views from one field over serialization, preserving separate obligations', async () => {
    const note = withCarryNoteWalls(withCarryNoteChecks(
      'RETRACTED: prior acceptance claim. Next: run the focused regression.', [{
        id: 'source-proof', claim: 'Source-only proof', verified: 'saved-receipt', sinceMs: now - 1000,
      }],
    ), [{ id: 'runtime-wall', claim: 'No runtime restart', recheck: 'Read approved scope', sinceMs: now - 2000 }]);
    // This is renderer/reader-contract proof, not a claim of real PG persistence.
    const items = [held(note), held('Independent review stays open.', 'WI-B')];
    const reader = vi.fn(async () => JSON.parse(JSON.stringify(items)) as CarryBriefHeldItem[]);
    const read = async () => (await readLeaderCheckpointProgress(
      [member(owner, [claim(), claim('WI-B')])], ws, { readHeldItems: reader, nowMs: now },
    )).get(owner)!;
    const first = await read();
    expect(first.status).toBe('read');
    expect(first.items[0]).toMatchObject({
      checkpoint: note, checkpointUpdatedAtMs: now, checkpointContentHash: shortCarryHash(note),
      checks: 1, walls: 1, checkpointTruncated: false,
    });
    expect(first.items[1].checkpoint).toBe('Independent review stays open.');
    const brief = {
      ownerId: owner, workspaceId: ws, loop: null, heldItems: await reader(),
      directives: [], directivesTotalOpen: 0, walls: [], facts: [], awaits: [], fleet: null,
    } as CarryBrief;
    const doc: CarryDoc = {
      brief, identity: { ownerId: owner, ownerLabel: null, workspaceId: ws, harness: 'fixture', fleet: null, account: null },
      sessionMode: { modes: [], loopActive: false, loopIntervalSec: null }, planItems: [], asks: [], tail: [],
      continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true },
    };
    for (const rendered of [renderCarryBriefText(brief, now), renderCarryDoc(doc, now)]) {
      expect(rendered).toContain('Next: run the focused regression.');
      expect(rendered).toContain('Independent review stays open.');
      // Cold carry intentionally excerpts the body; omitted rows are still
      // present on the canonical item and recoverable, not silently retired.
      expect(rendered).toContain("work_items:get { id: 'WI-A', harness: 'fixture' }");
    }
    expect(first.items[0].checkpoint).toContain('No runtime restart');
    expect(renderCarryDoc(doc, now)).toContain('BLIND WINDOW');
    expect(renderCarryDoc(doc, now)).toContain('RETRACTED CLAIMS');
    items[0] = held('Next: verify the changed input.');
    expect((await read()).items[0].checkpoint).toBe(items[0].checkpoint);
    expect(brief.heldItems[0].checkpoint).toBe(note);
    expect((await read()).snapshotOnly).toBe(true);
    expect(reader).toHaveBeenCalledWith(owner, ws, { limit: LEADER_PROGRESS_ITEM_LIMIT });
  });

  it.each([
    { holderProof: null },
    { holderProof: { ownerId: 'peer', workspaceId: ws } },
    { holderProof: { ownerId: owner, workspaceId: 'other-workspace' } },
    { harness: 'other-harness' },
  ])('never attributes unproven or differently scoped checkpoint prose: %j', async (change) => {
    const result = (await readLeaderCheckpointProgress([member()], ws, {
      readHeldItems: async () => [{ ...held('Do not leak this peer instruction.'), ...change }],
    })).get(owner)!;
    expect(result.status).toBe('unknown');
    expect(result.items).toEqual([]);
    expect(result.omitted).toBe(1);
    expect(JSON.stringify(result)).not.toContain('Do not leak');
  });

  it('distinguishes unavailable checkpoint reads from confirmed absence', async () => {
    for (const failed of [false, true]) {
      const result = (await readLeaderCheckpointProgress([member()], ws, {
        readHeldItems: async () => [{ ...held(null), checkpointReadFailed: failed }],
      })).get(owner)!;
      expect(result.status).toBe(failed ? 'unknown' : 'read');
      expect(result.items[0].status).toBe(failed ? 'unknown' : 'empty');
      expect(result.items[0].checks).toBe(failed ? null : 0);
    }
  });

  it('bounds stalled reads and never backfills a late result into a returned snapshot', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let finish!: (items: CarryBriefHeldItem[]) => void;
    const pending = readLeaderCheckpointProgress([member()], ws, {
      timeoutMs: 20, readHeldItems: () => new Promise((resolve) => { finish = resolve; }),
    });
    await vi.advanceTimersByTimeAsync(21);
    const result = (await pending).get(owner)!;
    expect(result.status).toBe('unknown');
    finish([held('Late state')]);
    await vi.advanceTimersByTimeAsync(1);
    expect(result.items).toEqual([]);
  });

  it('reports thrown reads as unknown rather than empty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = (await readLeaderCheckpointProgress([member()], ws, {
      readHeldItems: async () => { throw new Error('unavailable'); },
    })).get(owner)!;
    expect(result.status).toBe('unknown');
    expect(result.note).toContain('unavailable');
  });

  it('caps member fan-out and ignores inactive/non-item claims', async () => {
    const reader = vi.fn(async () => [] as CarryBriefHeldItem[]);
    const members = Array.from({ length: 20 }, (_, i) => member(`owner-${i}`));
    members.push(member('inactive', [{ ...claim(), active: false }]));
    members.push(member('plan-only', [{ ...claim(), type: 'plan-item' }]));
    const result = await readLeaderCheckpointProgress(members, ws, { readHeldItems: reader });
    expect(reader).toHaveBeenCalledTimes(LEADER_PROGRESS_MEMBER_LIMIT);
    expect(result.get('owner-19')?.status).toBe('omitted');
    expect(result.has('inactive')).toBe(false);
    expect(result.has('plan-only')).toBe(false);
  });

  it('marks text and item truncation, retaining full-note hash and recovery identity', async () => {
    const note = 'x'.repeat(LEADER_PROGRESS_TEXT_LIMIT + 20);
    const items = Array.from({ length: 8 }, (_, i) => held(note, `WI-${i}`));
    const result = (await readLeaderCheckpointProgress(
      [member(owner, items.map((item) => claim(item.id)))], ws, { readHeldItems: async () => items },
    )).get(owner)!;
    expect(result.items).toHaveLength(LEADER_PROGRESS_ITEM_LIMIT);
    expect(result.omitted).toBe(5);
    expect(result.items[0]).toMatchObject({
      checkpointTruncated: true, checkpointChars: note.length, checkpointContentHash: shortCarryHash(note),
      recovery: { tool: 'work_items:get', args: { id: 'WI-0', harness: 'fixture' } },
    });
    expect(result.items[0].checkpoint).toHaveLength(LEADER_PROGRESS_TEXT_LIMIT);
  });

  it('refuses unresolved workspace scope without reading', async () => {
    const reader = vi.fn(async () => [] as CarryBriefHeldItem[]);
    expect((await readLeaderCheckpointProgress([member()], '*', { readHeldItems: reader })).get(owner)?.status)
      .toBe('unknown');
    expect(reader).not.toHaveBeenCalled();
  });
});
