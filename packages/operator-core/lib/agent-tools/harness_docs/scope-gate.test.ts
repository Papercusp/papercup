import { describe, it, expect, beforeEach, vi } from 'vitest';

// PG/git-free parametric unit: every harness_docs:* tool is harness-scoped and must
// return { ok:false, error:'harness_required' } with isError:true — and call NONE of
// its delegates — when resolveHarnessScope yields a non-harness scope (operator '*'
// ctx + no `harness` arg). Only set_overlay was spot-checked before; one missing
// guard means a write keyed by an undefined slug. (D3 — harness-docs gap sweep.)
//
// Every delegate the seven handlers touch is mocked here so a fired guard touching
// nothing is verifiable, and so a leaked call would throw (the mocks return rejects
// by default would be noisy — they're spies that record + return innocuous values).
vi.mock('../../harness/docs/manual-anchor', () => ({
  anchorManualDoc: vi.fn(),
  verifyManualDoc: vi.fn(),
}));
vi.mock('../../harness/docs/provenance', () => ({ recordGeneratedDoc: vi.fn() }));
vi.mock('../../harness/docs/migrate-fs-docs', () => ({ ingestHarnessDocs: vi.fn() }));
vi.mock('../../harness/docs/regenerate', () => ({ requestRegeneration: vi.fn() }));
vi.mock('../../harness/docs/merged-read', () => ({ buildMergedDocs: vi.fn() }));
vi.mock('../../harness/docs/doc-record', () => ({
  getDocRecord: vi.fn(),
  setDocOverlay: vi.fn(),
  upsertDocRecord: vi.fn(),
}));

import anchorTool from './anchor';
import recordTool from './record';
import ingestTool from './ingest';
import regenerateTool from './regenerate';
import verifyTool from './verify';
import listTool from './list';
import setOverlayTool from './set_overlay';

import { anchorManualDoc, verifyManualDoc } from '../../harness/docs/manual-anchor';
import { recordGeneratedDoc } from '../../harness/docs/provenance';
import { ingestHarnessDocs } from '../../harness/docs/migrate-fs-docs';
import { requestRegeneration } from '../../harness/docs/regenerate';
import { buildMergedDocs } from '../../harness/docs/merged-read';
import { getDocRecord, setDocOverlay, upsertDocRecord } from '../../harness/docs/doc-record';

type ToolLike = {
  name: string;
  handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
};
const asTool = (t: unknown) => t as unknown as ToolLike;
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

// All the delegates the seven handlers could call — assert NONE fire when gated.
const ALL_DELEGATES = [
  anchorManualDoc,
  verifyManualDoc,
  recordGeneratedDoc,
  ingestHarnessDocs,
  requestRegeneration,
  buildMergedDocs,
  getDocRecord,
  setDocOverlay,
  upsertDocRecord,
].map((d) => vi.mocked(d));

// Minimal valid args per tool (docId where required) — the gate must fire BEFORE
// any of these matter, so we keep them present to prove it's the scope, not a schema miss.
const TOOLS: Array<{ tool: unknown; args: Record<string, unknown> }> = [
  { tool: anchorTool, args: { docId: 'guides/setup.md' } },
  { tool: recordTool, args: { docId: 'features/F-1.md' } },
  { tool: ingestTool, args: {} },
  { tool: regenerateTool, args: { docId: 'features/F-1.md' } },
  { tool: verifyTool, args: { docId: 'guides/setup.md' } },
  { tool: listTool, args: { docId: 'features/F-1.md' } },
  { tool: setOverlayTool, args: { docId: 'features/F-1.md', overlay: 'why' } },
];

describe('harness_docs:* harness-scope gate (D3)', () => {
  beforeEach(() => vi.clearAllMocks());

  // The two non-harness scopes resolveHarnessScope can yield with no `harness` arg:
  //   ctx '*'  → operator-default sentinel → 'none'
  //   ctx unset → 'none'
  for (const ctx of [{ harnessSlug: '*' }, {}] as const) {
    const label = 'harnessSlug' in ctx ? "ctx harnessSlug:'*'" : 'ctx with no harnessSlug';
    describe(label, () => {
      for (const { tool, args } of TOOLS) {
        const t = asTool(tool);
        it(`${t.name} → harness_required, isError, touches no delegate`, async () => {
          const res = await t.handler(args, ctx);
          expect(res.isError).toBe(true);
          expect(body(res)).toEqual({ ok: false, error: 'harness_required' });
          for (const d of ALL_DELEGATES) expect(d).not.toHaveBeenCalled();
        });
      }
    });
  }

  // Teeth: a concrete ctx harness slug (scoped session, no arg) must NOT trip the gate
  // — proves the parametric assertion is testing the gate, not a blanket "always errors".
  it('a concrete ctx harnessSlug passes the gate (list reaches buildMergedDocs)', async () => {
    vi.mocked(buildMergedDocs).mockResolvedValue({
      ok: true,
      files: [],
      entries: [],
      activePath: null,
      content: null,
      activeEntry: null,
    });
    const res = await asTool(listTool).handler({ docId: 'features/F-1.md' }, { harnessSlug: 'demo' });
    expect(res.isError).toBeFalsy();
    expect(vi.mocked(buildMergedDocs)).toHaveBeenCalledWith('demo', expect.any(Object));
  });

  // Teeth: an explicit `harness: 'all'` arg resolves to { kind:'all' } — NOT 'harness'
  // — so these harness-only writers still gate (they require a CONCRETE harness).
  it("explicit harness:'all' is still gated (kind:'all' ≠ 'harness')", async () => {
    const res = await asTool(anchorTool).handler({ harness: 'all', docId: 'guides/setup.md' }, {});
    expect(res.isError).toBe(true);
    expect(body(res)).toEqual({ ok: false, error: 'harness_required' });
    expect(vi.mocked(anchorManualDoc)).not.toHaveBeenCalled();
  });
});
