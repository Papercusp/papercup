/** Deterministic carry-document builder (deterministic-context-carry P-009):
 *  the seam-driven assembly (identity + session-mode + plan-state + asks + tail
 *  layered on the carry brief) and the pure full-document renderer. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { CarryBrief } from './carry-brief';
import {
  buildCarryDoc,
  renderCarryDoc,
  SELF_RECALL_POINTER,
  REORIENT_BANNER,
  CARRY_DOC_MAX_TAIL_TURNS,
  CARRY_DOC_MAX_PLAN_ITEMS,
  type CarryDoc,
  type CarryDocPlanItem,
  type CarryDocAsk,
  type CarryDocTailTurn,
} from './carry-doc';

const NOW = 1_800_000_000_000;

function brief(over: Partial<CarryBrief> = {}): CarryBrief {
  return {
    ownerId: 'su-1',
    loop: { harness: 'papercusp', active: true, intervalSec: 60, carryNote: '## Next\ngo', carryNoteUpdatedAtMs: NOW },
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
    ...over,
  };
}

describe('buildCarryDoc (seam-driven assembly)', () => {
  const base = {
    workspaceId: 'ws-1',
    harness: 'papercusp',
    ownerLabel: 'su · su-1',
    buildCarryBriefFn: async () => brief(),
    getModesFn: async () => [{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }],
  };

  it('assembles identity + session-mode from the brief + seams', async () => {
    const doc = await buildCarryDoc('su-1', base);
    expect(doc.identity).toMatchObject({ ownerId: 'su-1', harness: 'papercusp', workspaceId: 'ws-1', ownerLabel: 'su · su-1' });
    expect(doc.sessionMode.loopActive).toBe(true);
    expect(doc.sessionMode.loopIntervalSec).toBe(60);
    expect(doc.sessionMode.modes).toEqual([{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }]);
  });

  it('a throwing brief build degrades to an empty brief, never throws', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      buildCarryBriefFn: async () => {
        throw new Error('db down');
      },
    });
    expect(doc.brief.heldItems).toEqual([]);
    expect(doc.sessionMode.loopActive).toBe(false);
  });

  it('a throwing mode seam yields no modes, never a failed document', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      getModesFn: async () => {
        throw new Error('modes down');
      },
    });
    expect(doc.sessionMode.modes).toEqual([]);
  });

  it('caps the tail to the most-recent N turns', async () => {
    const turns: CarryDocTailTurn[] = Array.from({ length: CARRY_DOC_MAX_TAIL_TURNS + 4 }, (_, i) => ({
      speaker: 'assistant',
      text: `turn ${i}`,
      ts: null,
    }));
    const doc = await buildCarryDoc('su-1', { ...base, getTailFn: async () => turns });
    expect(doc.tail).toHaveLength(CARRY_DOC_MAX_TAIL_TURNS);
    expect(doc.tail[doc.tail.length - 1].text).toBe(`turn ${CARRY_DOC_MAX_TAIL_TURNS + 3}`);
  });

  it('the plan-state seam flows through and is capped to the max', async () => {
    const many: CarryDocPlanItem[] = Array.from({ length: CARRY_DOC_MAX_PLAN_ITEMS + 3 }, (_, i) => ({
      itemId: `P-${i}`,
      planSlug: 'plan-x',
      status: 'wip',
      disposition: 'active',
    }));
    const doc = await buildCarryDoc('su-1', { ...base, getPlanItemsFn: async () => many });
    expect(doc.planItems).toHaveLength(CARRY_DOC_MAX_PLAN_ITEMS);
    expect(doc.planItems[0]).toMatchObject({ itemId: 'P-0', planSlug: 'plan-x', disposition: 'active' });
  });

  it('asks / tail default to empty when no seam or transcript is given', async () => {
    const doc = await buildCarryDoc('su-1', { ...base, getPlanItemsFn: async () => [] });
    expect(doc.asks).toEqual([]);
    expect(doc.tail).toEqual([]);
  });

  it('the real tail leg reads a transcript file when a path is supplied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-carry-doc-test-'));
    try {
      const f = join(dir, 'sess.jsonl');
      const line = (role: 'user' | 'assistant', text: string, ts: string) =>
        JSON.stringify({ type: role, timestamp: ts, sessionId: 's', message: { role, content: [{ type: 'text', text }] } });
      writeFileSync(
        f,
        [
          line('user', 'ship the carry doc', '2026-07-14T10:00:00Z'),
          line('assistant', 'wiring the tail reader', '2026-07-14T10:00:05Z'),
        ].join('\n') + '\n',
      );
      const doc = await buildCarryDoc('su-1', { ...base, getPlanItemsFn: async () => [], transcriptPath: f });
      expect(doc.tail.map((t) => t.text)).toEqual(['ship the carry doc', 'wiring the tail reader']);
      expect(doc.tail[1].speaker).toBe('assistant');
      expect(doc.tail[0].ts).toBe('2026-07-14T10:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderCarryDoc (pure)', () => {
  const planItems: CarryDocPlanItem[] = [
    { itemId: 'P-009', planSlug: 'deterministic-context-carry-2026-07-14', status: 'wip', disposition: 'claimed' },
  ];
  const asks: CarryDocAsk[] = [{ id: '7', question: 'Which backend for the sweep?', askedAtMs: NOW }];
  const tail: CarryDocTailTurn[] = [
    { speaker: 'owner', text: 'ship it', ts: '2026-07-14T10:00:00Z' },
    { speaker: 'assistant', text: 'on it', ts: '2026-07-14T10:00:05Z' },
  ];

  function doc(over: Partial<CarryDoc> = {}): CarryDoc {
    return {
      brief: brief(),
      identity: { ownerId: 'su-1', ownerLabel: 'su · su-1', harness: 'papercusp', workspaceId: 'ws-1', fleet: { slug: 'f1', role: 'leader' }, account: 'default' },
      sessionMode: { modes: [{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }], loopActive: true, loopIntervalSec: 60 },
      planItems,
      asks,
      tail,
      ...over,
    };
  }

  it('renders every section in priority order with the banner + self-recall', () => {
    const text = renderCarryDoc(doc(), NOW);
    expect(text).toContain('# Carry document (deterministic');
    expect(text).toContain(REORIENT_BANNER);
    expect(text).toContain('## Identity');
    expect(text).toContain('su-id: su-1 (su · su-1)');
    expect(text).toContain('fleet: f1 (leader)');
    expect(text).toContain('## Session mode');
    expect(text).toContain('AUTO: on (owner-directed)');
    expect(text).toContain('loop: ARMED (every 60s)');
    expect(text).toContain('## Standing carry');
    expect(text).toContain('P-009 [wip] deterministic-context-carry-2026-07-14 (claimed)');
    expect(text).toContain('## Open owner asks');
    expect(text).toContain('Which backend for the sweep?');
    expect(text).toContain('## Verbatim tail');
    expect(text).toContain('### OWNER @2026-07-14T10:00:00Z');
    expect(text).toContain('ship it');
    expect(text).toContain('## Self-recall');
    expect(text).toContain(SELF_RECALL_POINTER);
    // Order: identity precedes session mode precedes standing carry precedes tail.
    expect(text.indexOf('## Identity')).toBeLessThan(text.indexOf('## Session mode'));
    expect(text.indexOf('## Session mode')).toBeLessThan(text.indexOf('## Standing carry'));
    expect(text.indexOf('## Verbatim tail')).toBeLessThan(text.indexOf('## Self-recall'));
  });

  it('omits empty optional sections but always keeps banner/identity/mode/self-recall', () => {
    const text = renderCarryDoc(doc({ planItems: [], asks: [], tail: [] }), NOW);
    expect(text).not.toContain('## Plan state');
    expect(text).not.toContain('## Open owner asks');
    expect(text).not.toContain('## Verbatim tail');
    expect(text).toContain('## Identity');
    expect(text).toContain('## Session mode');
    expect(text).toContain('## Self-recall');
  });

  it('a not-armed loop renders the halt warning', () => {
    const text = renderCarryDoc(doc({ sessionMode: { modes: [], loopActive: false, loopIntervalSec: null } }), NOW);
    expect(text).toContain('loop: not armed');
    expect(text).toContain('- no active modes');
  });
});
