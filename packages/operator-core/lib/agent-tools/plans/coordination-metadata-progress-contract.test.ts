/**
 * P-001 representative progress and tool-input fixtures.
 *
 * These run the real renderers and Zod input contracts. No live database,
 * network, reviewer, or clock latency is measured. Existing safe behavior is
 * a preservation baseline, not a saving attributable to this plan.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import {
  renderCarryBriefText, type CarryBrief,
} from '../../carry-brief';
import { renderCarryDoc, type CarryDoc } from '../../carry-doc';
import {
  splitCarryNoteChecks, splitCarryNoteWalls, withCarryNoteChecks, withCarryNoteWalls,
} from '../../carry-note';
import readTool from '../sessions/read';
import handoffTool from '../coordination/tools/handoff';
import { openHandoff } from '../coordination/handoffs';
import { applyResultProjection, type ProjectableResult } from '../../result-projection/apply';
import { parseProjection } from '../../result-projection/parse';
import { metadataHarness, metadataWorkflowTargets } from './coordination-metadata-fixtures';

const io = vi.hoisted(() => ({
  database: vi.fn(() => { throw new Error('unexpected live database access in metadata fixture'); }),
  putEvent: vi.fn(async (_surface: string, _id: string, _record: unknown) => {}),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: io.database,
}));
// The sessions module transitively imports search/embed-backfill, which boots
// the memory settings cache. That unrelated boot reader is not part of these
// schema/renderer fixtures. Stub its explicit seam, not the no-database guard.
vi.mock('../../memory/backend-selection', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../memory/backend-selection')>(),
  initMemoryBackendSelection: async () => {},
}));
vi.mock('../coordination/log', async (importOriginal) => ({
  ...await importOriginal<typeof import('../coordination/log')>(),
  coordLog: { putEvent: io.putEvent },
}));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...await importOriginal<typeof import('../coordination/identity')>(),
  resolveAgentIdentity: () => ({
    ownerId: 'metadata-fixture-owner', ownerLabel: null,
    source: 'omp-hook-session', workspaceId: 'metadata-fixture-workspace', userId: null,
  }),
}));

afterEach(() => {
  try {
    const attempts = io.database.mock.results.map((result) => (result.value as Error)?.stack).join('\n');
    expect(io.database, attempts).not.toHaveBeenCalled();
  } finally {
    vi.clearAllMocks();
  }
});

const now = Date.parse('2026-09-07T16:00:00.000Z');
const ownerId = 'metadata-fixture-owner';
const workspaceId = 'metadata-fixture-workspace';
const operationId = 'WI-METADATA-PROGRESS';
const next = 'Next: implement the fixture input preflight.';

function checkpoint(text = next): string {
  return withCarryNoteWalls(withCarryNoteChecks(text, [{
    id: 'progress-proof', claim: 'Focused source check only',
    verified: 'fixture-receipt', sinceMs: now - 1_000,
  }]), [{
    id: 'runtime-wall', claim: 'No runtime restart',
    recheck: 'Read the approved scope', sinceMs: now - 2_000,
  }]);
}

function progressBrief(note: string, loopNote: string | null = null): CarryBrief {
  return {
    ownerId, workspaceId,
    loop: {
      harness: metadataHarness, active: true, intervalSec: 1200,
      goal: `Advance ${operationId}`,
      carryNote: loopNote, carryNoteUpdatedAtMs: loopNote ? now - 60_000 : null,
    },
    heldItems: [{
      id: operationId, title: 'Metadata fixture', body: null,
      harness: metadataHarness, checkpoint: note, checkpointUpdatedAtMs: now,
      holderProof: { ownerId, workspaceId },
    }, {
      id: 'WI-SEPARATE-OBLIGATION', title: 'Separate review obligation', body: null,
      harness: metadataHarness, checkpoint: 'Do not close the independent review.',
      checkpointUpdatedAtMs: now,
      holderProof: { ownerId, workspaceId },
    }],
    directives: [], directivesTotalOpen: 0, walls: [], facts: [],
    awaits: [], fleet: null,
  };
}

function document(brief: CarryBrief): CarryDoc {
  return {
    brief,
    identity: { ownerId, ownerLabel: null, harness: metadataHarness, workspaceId, fleet: null, account: null },
    sessionMode: { modes: [], loopActive: true, loopIntervalSec: 1200 },
    planItems: [], asks: [], tail: [],
    continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true },
  };
}

describe('P-001 scoped progress preservation baseline', () => {
  it('renders one checkpoint in both continuity views without authoring a second narrative', () => {
    const brief = progressBrief(checkpoint());
    for (const rendered of [
      renderCarryBriefText(brief, now),
      renderCarryDoc(document(brief), now),
    ]) {
      expect(rendered).toContain(next);
      expect(rendered).toContain('Do not close the independent review.');
    }
    expect(brief.loop?.carryNote).toBeNull();
    expect(brief.heldItems[0].checkpointUpdatedAtMs).toBe(now);
    // Count AUTHORING fields, not rendered repetitions or network requests.
    expect([brief.loop?.carryNote, brief.heldItems[0].checkpoint].filter(Boolean)).toHaveLength(1);
  });

  it('preserves separate check/wall identity, evidence and timestamps over JSON restart serialization', () => {
    const restored = JSON.parse(JSON.stringify(progressBrief(checkpoint()))) as CarryBrief;
    const note = restored.heldItems[0].checkpoint;
    expect(splitCarryNoteChecks(note).checks).toEqual([{
      id: 'progress-proof', claim: 'Focused source check only',
      verified: 'fixture-receipt', sinceMs: now - 1_000,
    }]);
    expect(splitCarryNoteWalls(note).walls).toEqual([{
      id: 'runtime-wall', claim: 'No runtime restart',
      recheck: 'Read the approved scope', sinceMs: now - 2_000,
    }]);
    const rendered = renderCarryDoc(document(restored), now);
    expect(rendered).toContain('BLIND WINDOW');
    expect(rendered).toContain('2026-09-07T16:00:00.000Z');
    expect(rendered).toContain('RETRACTED CLAIMS');
  });

  it('does not hand a reassigned checkpoint to the wrong successor as its own work', () => {
    const brief = progressBrief(checkpoint());
    brief.heldItems[0].holderProof = { ownerId: 'different-holder', workspaceId };
    for (const rendered of [
      renderCarryBriefText(brief, now),
      renderCarryDoc(document(brief), now),
    ]) {
      expect(rendered).not.toContain(next);
      expect(rendered).toContain(operationId);
      expect(rendered).toContain('Do not close the independent review.');
    }
  });

  it('characterizes the stale-copy risk when one operation has two authored narratives', () => {
    const prior = 'Next: obtain the input schema before implementation.';
    const brief = progressBrief(checkpoint(), prior);
    const rendered = renderCarryDoc(document(brief), now);
    expect(rendered).toContain(prior);
    expect(rendered).toContain(next);
    // P-005 target: ONE authored progress field for this operation, with other
    // views deriving it. This fixture intentionally has TWO; it is not evidence
    // that every live agent copies progress, or that separate obligations merge.
    expect([brief.loop?.carryNote, brief.heldItems[0].checkpoint].filter(Boolean))
      .toHaveLength(metadataWorkflowTargets.authoredProgressFields.before);
  });
});

describe('P-001 input-contract preservation baseline', () => {
  it.each([
    { session: 'self', tail: 2 },
    { session: 'fixture-session', limit: 2, order: 'asc' },
    { ref: 'session_turn:codex:fixture-session:4', text_offset: 50, text_limit: 100 },
  ])('accepts a valid bounded session request %j', (args) => {
    expect(readTool.args.safeParse(args).success).toBe(true);
  });

  it.each([
    { session: 'self', tail: 2, limit: 2 },
    { session: 'self', tail: 2, order: 'desc' },
    { session: 'self', ref: 'session_turn:codex:fixture-session:4' },
    { session: 'self', mode: 'verbatim' },
    { session: 'self', text_limit: 4001 },
  ])('rejects incompatible or unknown request fields %j', (args) => {
    expect(readTool.args.safeParse(args).success).toBe(false);
  });

  it('keeps prose plan references valid instead of parsing them as a claim lane', () => {
    const result = handoffTool.args.safeParse({
      to: ['fixture-reviewer'], summary: 'Review the P-001 and P-002 boundary',
      body: 'P-001 remains partial; P-002 is a dependent item, not an assignment.',
    });
    expect(result.success).toBe(true);
  });

  it('enforces open-handoff fields while preserving acceptance by existing identity', () => {
    // P-006 reconciles the published input contract with handler-level refusal.
    // Only the schema is exercised; no handoff, flush gate, or wake is invoked.
    expect(handoffTool.args.safeParse({}).success).toBe(false);
    expect(handoffTool.args.safeParse({ accept_msg_id: 'fixture-existing-handoff' }).success).toBe(true);
  });

  it('keeps schema and defensive handler errors aligned without writing or waking a recipient', async () => {
    const context: UnifiedToolContext = {
      harnessSlug: metadataHarness, workspaceId,
      log: () => {}, signal: new AbortController().signal,
      progress: () => {}, emit: () => {},
    };
    const parsed = handoffTool.args.safeParse({});
    expect(parsed.success).toBe(false);
    // Direct handler callers retain the existing defensive refusal too.
    const result = await handoffTool.handler({}, context);
    expect(result).toMatchObject({ isError: true });
    if (!('content' in result)) throw new Error('missing handler content');
    const text = result.content.find((part) => part.type === 'text');
    expect(text?.type).toBe('text');
    if (!text || text.type !== 'text') throw new Error('missing handler result');
    const body = JSON.parse(text.text);
    expect(body).toMatchObject({ ok: false, error: 'missing_fields' });
    if (!parsed.success) expect(parsed.error.issues[0]?.message).toBe(body.detail);
    expect(io.putEvent).not.toHaveBeenCalled();
  });

  it('preserves long handoff text at the actual writer seam, not an inbox display limit', async () => {
    // These are sample lengths, NOT a new maximum or a claim about dispatch
    // admission. The input schema and writer both preserve these exact values.
    const input = {
      to: ['fixture-reviewer'],
      summary: 's'.repeat(4097), body: 'b'.repeat(16001),
    };
    expect(handoffTool.args.safeParse(input).success).toBe(true);
    const record = await openHandoff({
      ownerId, ownerLabel: 'Metadata fixture', workspaceId, userId: null, source: 'omp-hook-session',
    }, input);
    expect(record.summary).toBe(input.summary);
    expect(record.body).toBe(input.body);
    expect(io.putEvent).toHaveBeenCalledExactlyOnceWith('handoffs', record.msg_id, record);
    expect(record).not.toHaveProperty('next_action');
    expect(record).not.toHaveProperty('files_modified');
  });
});

describe('P-001 projection root preservation', () => {
  const item = { id: operationId, workItem: { state: 'open', privateDetail: 'not selected' } };

  it.each([
    { body: [item], pick: ['[].id', '[].workItem.state'], expected: [{ id: operationId, workItem: { state: 'open' } }] },
    {
      body: { ok: true, results: [item] },
      pick: ['results[].id', 'results[].workItem.state'],
      expected: { results: [{ id: operationId, workItem: { state: 'open' } }] },
    },
  ])('projects the emitted root rather than guessing an object root for every tool', ({ body, pick, expected }) => {
    const parsed = parseProjection({ pick });
    if (!parsed.ok) throw new Error(parsed.error);
    const input: ProjectableResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const projected = applyResultProjection(input, parsed.spec);
    const text = projected.content.find((part) =>
      part.type === 'text' && typeof part.text === 'string' && !part.text.includes('[projection:'));
    expect(text).toBeDefined();
    expect(JSON.parse(String(text?.text))).toEqual(expected);
    expect(projected._meta?.resultProjection).toMatchObject({ applied: true });
  });
});
