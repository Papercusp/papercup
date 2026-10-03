/** Result door (deterministic-context-carry P-006 leg C) — cap a model-facing MCP
 *  tool result at the resultEach door, spill the FULL text to scratch behind a
 *  pointer; delta results and the kill-switch bypass; fail-soft on spill failure. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE } from './context-doors';

// P-023: the door resolves its constants through the config surface per call — stub it
// (the config module has its own suite) so these tests run PG-free and one case can
// exercise a per-session override widening the budget.
const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('./context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import type { DoorableResult } from './result-door';
import {
  applyResultDoor,
  beginResultDoorAggregate,
  buildProjectionHint,
  measureResultContextBytes,
  resetResultDoorAggregatesForTests,
  RESULT_DOOR_TOKENS,
} from './result-door';
import { applyResultProjection } from './result-projection/apply';
import { parseProjection } from './result-projection/parse';
import { parseScratchReference } from './scratch-reference';

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const RUN_ID = '11111111-2222-4333-8444-555555555555';

let sandbox: string;
let prevScratchRoot: string | undefined;
let prevKillSwitch: string | undefined;

beforeEach(() => {
  // os.homedir() reads /etc/passwd not $HOME on Linux — the env-var override is
  // the one seam that redirects scratch writes (same setup as scratch-gc.test.ts).
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-result-door-test-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  prevKillSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
  delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
  resetResultDoorAggregatesForTests();
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  if (prevKillSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  else process.env.PAPERCUSP_RESULT_DOOR_OFF = prevKillSwitch;
  rmSync(sandbox, { recursive: true, force: true });
});

function longText(chars: number): string {
  return Array.from({ length: Math.ceil(chars / 40) }, (_, i) => `line ${i} of a very long tool result`)
    .join('\n')
    .slice(0, chars);
}

/** The single spill file written under <scratchRoot>/<ws>/<tool>/<runId>/. */
function readSpill(ws: string, tool: string, runId: string): string {
  const dir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, ws, tool, runId);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const bytes = readFileSync(join(dir, files[0]));
  const reference = parseScratchReference(bytes);
  expect(reference).not.toBeNull();
  return reference!.payload.toString('utf8');
}

function boundedBody(result: DoorableResult): {
  text?: string;
  _projection: {
    cursor: Record<string, unknown>;
    next: string;
    kind: string;
    truncated: boolean;
  };
} {
  const textItems = result.content.filter((item) => (item as { type?: unknown }).type === 'text') as Array<{
    text: string;
  }>;
  expect(textItems).toHaveLength(1);
  return JSON.parse(textItems[0].text) as {
    text?: string;
    _projection: {
      cursor: Record<string, unknown>;
      next: string;
      kind: string;
      truncated: boolean;
    };
  };
}

describe('applyResultDoor', () => {
  it('a result within the budget passes through as the SAME object (no copy, no spill)', () => {
    const result = { content: [{ type: 'text' as const, text: 'small result' }] };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
  });

  it('an over-door text result is structurally bounded + pointered, and the spill holds the original', () => {
    const original = longText(BUDGET_CHARS * 3);
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored);
    const resultDoor = (doored as unknown as { _meta: { resultDoor: { originalBytes: number } } })._meta.resultDoor;
    expect(resultDoor.originalBytes).toBe(Buffer.byteLength(original, 'utf8'));
    expect(measureResultContextBytes(doored)).toBeLessThan(Buffer.byteLength(original, 'utf8'));
    expect(body.text).toContain('line 0 of a very long tool result');
    expect(body.text).not.toBe(original);
    expect(body._projection).toMatchObject({ kind: 'bounded-payload', truncated: true });
    expect(JSON.stringify(body._projection.cursor)).toContain('papercusp://scratch/ws-1/plans:get/' + RUN_ID);
    const spill = readSpill('ws-1', 'plans:get', RUN_ID);
    expect(spill).toContain('# tool: plans:get');
    expect(spill.endsWith(original)).toBe(true);
  });

  it('EI-21566007420787313: a bounded work_items:get batch never emits an unmarked partial row', () => {
    const results = Array.from({ length: 3 }, (_, i) => {
      const id = `WI-${42_200 + i}`;
      return {
        ok: true,
        id,
        workItem: {
          id,
          kind: 'bug',
          family: 'issue',
          state: 'open',
          title: `work item ${i}`,
          summary: 'S'.repeat(2_000),
          assignee: `su-${i}`,
          takenAt: '2026-08-27T00:53:51.717Z',
          ...Object.fromEntries(Array.from({ length: 32 }, (_, j) => [`diagnostic${j}`, `D${j}`.repeat(40)])),
        },
        holder: { goalRef: id, agreement: 'sole', detail: 'H'.repeat(800) },
        checkpoint: 'C'.repeat(1_500),
        checkpointAgeMs: 100,
        checkpointUpdatedAtMs: 200,
      };
    });
    const source = { ok: true, results, counts: { ok: results.length, failed: 0 } };
    const text = JSON.stringify(source);
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text }] },
      { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const projected = JSON.parse((doored.content[0] as { text: string }).text) as {
      results: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(projected.results)).toBe(true);

    const realRows = projected.results.filter((row) => row._truncated !== true);
    expect(realRows.length).toBeGreaterThan(0);
    let sawPartial = false;
    for (const row of realRows) {
      // The live failure was a terminal `{ok:true}` husk. Correlation identity
      // must win the final bytes of every real row.
      expect(row.id).toEqual(expect.stringMatching(/^WI-/));
      const original = results.find((candidate) => candidate.id === row.id)!;
      const rootLostField = Object.keys(original).some((key) => !(key in row));
      const workItem = row.workItem as Record<string, unknown> | undefined;
      const workItemLostField =
        workItem != null && Object.keys(original.workItem).some((key) => !(key in workItem));
      if (rootLostField) {
        sawPartial = true;
        expect(row._partial).toBe(true);
      }
      if (workItemLostField) {
        sawPartial = true;
        expect(workItem?._partial).toBe(true);
      }
    }
    // Calibration: if this turns false, the fixture no longer exercises the
    // dangerous field-loss direction and the assertions above are vacuous.
    expect(sawPartial).toBe(true);
  });

  it('EI-23196202383663962: the result door forwards custom bulk-envelope semantics so a tail failure stays visible', () => {
    const entries = [
      ...Array.from({ length: 16 }, (_, i) => ({
        outcome: 'ok',
        key: `WI-${i}`,
        detail: 'x'.repeat(4_000),
      })),
      { outcome: 'failed', key: 'WI-tail-failure', detail: 'x'.repeat(4_000) },
    ];
    const source = { accepted: true, entries, tally: { ok: 16, failed: 1 } };
    const text = JSON.stringify(source);
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text }] },
      {
        toolName: 'plans:bind-spec-evidence',
        workspaceId: 'ws-1',
        runId: RUN_ID,
        bulkEnvelope: { resultsKey: 'entries', failureKey: 'outcome', countsKey: 'tally' },
      },
    );
    const projected = JSON.parse((doored.content[0] as { text: string }).text) as {
      entries: Array<Record<string, unknown>>;
      tally: { ok: number; failed: number };
    };

    const visibleRows = projected.entries.filter((row) => row._truncated !== true);
    expect(visibleRows.map((row) => row.key)).toEqual(
      [...visibleRows]
        .sort((a, b) => entries.findIndex((source) => source.key === a.key) - entries.findIndex((source) => source.key === b.key))
        .map((row) => row.key),
    );
    expect(visibleRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outcome: 'failed',
        key: 'WI-tail-failure',
      }),
    ]));
    expect(visibleRows.at(-1)).toMatchObject({
      outcome: 'failed',
      key: 'WI-tail-failure',
    });
    expect(projected.tally).toEqual({ ok: 16, failed: 1 });
  });

  it('EI-21986877021459153: plans:get keeps nested item text through the generic result-door fallback', () => {
    const noise = (prefix: string) => Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => [`${prefix}-${i}`, `noise-${i}`]),
    );
    const itemText = 'Read this plan item before acting on the associated work.';
    const source = {
      ok: true,
      results: [{
        ...noise('result-noise'),
        ok: true,
        slug: 'detail-plan',
        items: [{
          ...noise('item-noise'),
          id: 'P-001',
          text: itemText,
          storedStatus: 'todo',
          effectiveStatus: 'todo',
        }],
      }],
      counts: { ok: 1, failed: 0 },
    };
    const original = JSON.stringify(source);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const projected = JSON.parse((doored.content[0] as { text: string }).text) as {
      results: Array<{ items?: Array<{ id?: string; text?: string }> }>;
    } & { _projection: { truncated: true } };
    const item = projected.results[0]?.items?.[0];

    // The result-door must retain the requested item rather than reducing the
    // row to identity/status fields. A short text remains byte-complete; if a
    // future budget change clips it, the projector's explicit marker is the
    // only acceptable alternative to a silent disappearance.
    expect(item).toMatchObject({ id: 'P-001' });
    expect(item?.text).toBe(itemText);
    expect(projected._projection.truncated).toBe(true);
  });

  it('EI-20435986111760474: oversized code:tools TypeScript stays valid JSON for direct and nested calls', () => {
    const signatures = Array.from(
      { length: 80 },
      (_, i) => `declare const tools${i}: { dev: { pgQuery(args: { sql: string }): Promise<unknown> } };`,
    ).join('\n');
    expect(signatures.length).toBeGreaterThan(BUDGET_CHARS);

    for (const toolName of ['code:tools', 'tools:invoke']) {
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: signatures }] },
        { toolName, workspaceId: 'ws-1', runId: RUN_ID },
      ) as DoorableResult;
      const body = boundedBody(doored);
      expect(body.text).toContain('declare const tools0');
      expect(body._projection).toMatchObject({
        kind: 'bounded-payload',
        truncated: true,
        cursor: { kind: 'scratch-page', tool: 'capability:read' },
      });
      expect((doored._meta!.resultDoor as { structural: boolean }).structural).toBe(true);
    }
  });

  it('structurally projects oversized text without corrupting schema-bearing structuredContent', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: `WI-${i}`,
      state: 'open',
      detail: 'x'.repeat(200),
    }));
    const original = JSON.stringify({ ok: true, rows });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }], structuredContent: { ok: true, rows } },
      { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID },
    ) as DoorableResult;
    const textItems = doored.content.filter((item) => (item as { type?: string }).type === 'text') as Array<{
      text: string;
    }>;
    expect(textItems).toHaveLength(1);
    expect(textItems[0].text.length).toBeLessThan(BUDGET_CHARS);
    const parsed = JSON.parse(textItems[0].text) as {
      _projection: {
        kind: string;
        cursor: { kind: string; tool: string; args: Record<string, unknown> };
        next: string;
      };
    };
    expect(parsed._projection.kind).toBe('bounded-payload');
    expect(parsed._projection.cursor).toMatchObject({
      kind: 'scratch-page',
      tool: 'capability:read',
      args: {
        byte_offset: 0,
        byte_limit: 3_072,
      },
    });
    expect(parsed._projection.cursor.args.file_path).toBe(
      (doored._meta!.resultDoor as { spillPath: string }).spillPath,
    );
    expect(parsed._projection.next).toContain('follow next_cursor;');
    // EI-20335562969900283: the bounded text projection is intentionally not
    // valid against an arbitrary tool's full output schema (it may omit rows
    // or required fields).  structuredContent was explicitly requested as the
    // lossless schema-bearing response and must therefore survive unchanged.
    expect(doored.structuredContent).toEqual({ ok: true, rows });
    expect((doored.structuredContent as { rows: typeof rows }).rows).toHaveLength(300);
    expect(
      (doored.structuredContent as { rows: typeof rows }).rows.every(
        (row) => typeof row.id === 'string' && typeof row.state === 'string' && typeof row.detail === 'string',
      ),
    ).toBe(true);
    expect((doored._meta!.resultDoor as { structural: boolean }).structural).toBe(true);
    expect(readSpill('ws-1', 'work_items:list', RUN_ID).endsWith(original)).toBe(true);
  });

  it('preserves a top-level array root for list-shaped JSON while retaining door recovery metadata', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: `WI-${i}`,
      state: 'open',
      detail: 'x'.repeat(200),
    }));
    const original = JSON.stringify(rows);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }], structuredContent: rows },
      { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID },
    ) as DoorableResult;
    const textItems = doored.content.filter((item) => (item as { type?: string }).type === 'text') as Array<{
      text: string;
    }>;
    expect(textItems).toHaveLength(1);
    expect(textItems[0].text.length).toBeLessThan(BUDGET_CHARS);

    const parsed = JSON.parse(textItems[0].text) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).not.toHaveProperty('_projection');
    expect(parsed).not.toHaveProperty('items');
    expect((parsed as unknown[]).length).toBeLessThan(rows.length);
    expect((parsed as unknown[]).at(-1)).toEqual(expect.objectContaining({
      kind: 'projection-truncation',
      type: 'projection-truncation',
      _truncated: true,
    }));

    const resultDoor = (doored._meta!.resultDoor as {
      structural: boolean;
      recoveryCursor: { kind: string; tool: string; args: Record<string, unknown> };
    });
    expect(resultDoor.structural).toBe(true);
    expect(resultDoor.recoveryCursor).toMatchObject({ kind: 'scratch-page', tool: 'capability:read' });
    expect(resultDoor.recoveryCursor.args.file_path).toBe(
      (doored._meta!.resultDoor as { spillPath: string }).spillPath,
    );
    expect(readSpill('ws-1', 'work_items:list', RUN_ID).endsWith(original)).toBe(true);
    expect(doored.structuredContent).toBe(rows);
  });

  it('REGRESSION (EI-23481355842555588): coord:thread array truncation is explicitly typed as a marker, not an empty message row', () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      msg_id: `coord-${index}`,
      kind: 'message',
      from: 'peer',
      summary: `reply-${index} ` + 'x'.repeat(240),
    }));
    const original = JSON.stringify({
      root: 'coord-0',
      entries,
      entries_shown: entries.length,
      entries_total: entries.length,
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'coord:thread', workspaceId: 'ws-1', runId: RUN_ID },
    ) as DoorableResult;
    const projected = JSON.parse((doored.content[0] as { text: string }).text) as {
      entries: Array<Record<string, unknown>>;
      _projection: { truncated: boolean };
    };
    const marker = projected.entries.at(-1);

    expect(projected._projection.truncated).toBe(true);
    expect(marker).toMatchObject({
      kind: 'projection-truncation',
      type: 'projection-truncation',
      _truncated: true,
    });
    expect(marker).not.toHaveProperty('msg_id');
    expect(marker).not.toHaveProperty('summary');
  });

  it('REGRESSION (EI-23481355842555588): coord:send delivery verdicts survive generic result-door trimming', () => {
    const noise = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`detail${index}`, 'n'.repeat(900)]),
    );
    const payload = {
      ok: true,
      results: [{
        ok: true,
        ...noise,
        msg_id: 'coord-send-verified-123',
        wake: {
          targets: ['peer-1'],
          queued: 1,
          woken: 1,
          wakeOutcome: 'queued',
          pickupConfirmed: false,
          recipient_absent: false,
          diagnostic: 'd'.repeat(BUDGET_CHARS * 2),
        },
        summary: 'delivery receipt ' + 's'.repeat(BUDGET_CHARS),
      }],
      counts: { ok: 1, failed: 0 },
    };
    const original = JSON.stringify(payload);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const door = (toolName: string) => {
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        { toolName, workspaceId: 'ws-1', runId: RUN_ID },
      ) as DoorableResult;
      return JSON.parse((doored.content[0] as { text: string }).text) as {
        results: Array<Record<string, any>>;
        _projection: { truncated: boolean };
      };
    };

    const parsed = door('coord:send');
    expect(parsed._projection.truncated).toBe(true);
    expect(parsed.results[0]).toMatchObject({
      msg_id: 'coord-send-verified-123',
      wake: {
        queued: 1,
        woken: 1,
        wakeOutcome: 'queued',
        pickupConfirmed: false,
        recipient_absent: false,
      },
    });

    // FALSIFIABILITY CONTROL: the same receipt-shaped bytes through an unrelated
    // tool have no coord:send preservation declaration, so the delivery verdict
    // is not passing merely because the fixture happened to fit.
    const control = door('plans:list');
    expect(control._projection.truncated).toBe(true);
    expect(control.results[0]).not.toHaveProperty('wake');
  });

  it('REGRESSION (EI-22186855527494865): plans:get shipReadiness survives the door while unrequested bulk does not', () => {
    // shipReadiness is OPT-IN and default-OFF: a caller only sees it by asking
    // for it by name, so its ABSENCE reads as "nothing is blocking this plan" —
    // a false green on a ship gate. Measured before the fix on a real read:
    // ok:true, omittedCount:24, omitted:[], and no shipReadiness key at all.
    const bulk = (prefix: string, n: number, len: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, 'x'.repeat(len)]));
    const payload = {
      ok: true,
      results: [{
        ok: true,
        slug: 'effort-scoped-continuity-2026-09-02',
        title: 'Effort-scoped continuity',
        status: 'draft',
        counts: { items: 126, decisions: 16, sections: 11 },
        harness: 'papercusp',
        // Unrequested default payload that outweighs the whole budget — the
        // eviction pressure that dropped the requested field.
        lifecycle: bulk('lc', 40, 400),
        frontmatter: bulk('fm', 40, 400),
        now: bulk('now', 40, 400),
        items: Array.from({ length: 126 }, (_, i) => ({ id: `P-${i}`, text: 'i'.repeat(400) })),
        // Assigned LAST by plans/get.ts, which is why insertion order could not
        // be relied on to save it.
        shipReadiness: {
          planSlug: 'effort-scoped-continuity-2026-09-02',
          satisfied: false,
          code: 'acceptance_ungraded',
          message: 'No acceptance rubric has been graded.',
        },
      }],
      counts: { ok: 1, failed: 0 },
    };
    const original = JSON.stringify(payload);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const door = (toolName: string) => {
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        { toolName, workspaceId: 'ws-1', runId: RUN_ID },
      ) as DoorableResult;
      const textItems = doored.content.filter(
        (item) => (item as { type?: string }).type === 'text',
      ) as Array<{ text: string }>;
      return JSON.parse(textItems[0].text) as {
        results: Array<Record<string, unknown>>;
        _projection: { truncated: boolean; omittedPreserved?: string[] };
      };
    };

    const parsed = door('plans:get');
    expect(parsed._projection.truncated).toBe(true);
    expect(parsed.results[0].shipReadiness).toMatchObject({
      satisfied: false,
      code: 'acceptance_ungraded',
    });
    // Nothing explicitly selected went missing, so the never-shed marker is absent.
    expect(parsed._projection.omittedPreserved).toBeUndefined();

    // FALSIFIABILITY CONTROL: the SAME bytes through a tool with no preserve
    // declaration lose the field to the same budget. Without this the assertion
    // above would also pass on a payload that simply fit.
    const control = door('plans:list');
    expect(control._projection.truncated).toBe(true);
    expect(control.results[0]).not.toHaveProperty('shipReadiness');
  });

  it('REGRESSION (EI-22626647927619840): work_items:complete keeps authority verdicts on later batch rows', () => {
    const results = Array.from({ length: 3 }, (_, i) => {
      const id = `EI-${22_626_647_927_619_840 + i}`;
      return {
        ok: true,
        id,
        completionAuthority: 'proposed',
        countsTowardBurnDown: false,
        authorityWarning:
          "completionAuthority:'proposed' — this close was recorded, but content identity was not committed at write time and the item is NOT counted toward burn-down.",
        requirementShortfallWarning:
          'Completion requirements were deferred because no requirementDisposition was supplied; verify the close before relying on it.',
        workItem: {
          id,
          kind: 'bug',
          state: 'resolved',
          title: `completion row ${i}`,
          summary: 'S'.repeat(3_000),
        },
        completion: { summary: 'C'.repeat(3_000), testsRun: ['focused'] },
      };
    });
    const payload = { ok: true, results, counts: { ok: results.length, failed: 0 } };
    const original = JSON.stringify(payload);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const door = (toolName: string) => {
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        { toolName, workspaceId: 'ws-1', runId: RUN_ID },
      ) as DoorableResult;
      const textItems = doored.content.filter(
        (item) => (item as { type?: string }).type === 'text',
      ) as Array<{ text: string }>;
      return JSON.parse(textItems[0].text) as {
        results: Array<Record<string, unknown>>;
        _projection: { truncated: boolean };
      };
    };

    const parsed = door('work_items:complete');
    expect(parsed._projection.truncated).toBe(true);
    const realRows = parsed.results.filter((row) => row._truncated !== true);
    expect(realRows).toHaveLength(results.length);
    for (const row of realRows) {
      expect(row.id).toEqual(expect.stringMatching(/^EI-/));
      expect(row.completionAuthority).toBe('proposed');
      expect(row.countsTowardBurnDown).toBe(false);
      expect(row.authorityWarning).toEqual(expect.any(String));
      expect(row.requirementShortfallWarning).toEqual(expect.any(String));
    }

    // FALSIFIABILITY CONTROL: the same bytes through an unrelated tool have no
    // work_items:complete preservation declaration, so the authority fields are
    // shed by the same generic budget rather than passing because the fixture fits.
    const control = door('plans:list');
    expect(control.results.some((row) => row.completionAuthority === undefined)).toBe(true);
  });

  it('REGRESSION (EI-22652581729405439): evaluator compact preview keeps all eight ratings and verdict metadata', () => {
    const criteria = [
      'traceability', 'fixture-calibration', 'falsifiability', 'correct-layer',
      'oracle-independence', 'execution-integrity', 'freshness', 'plan-class-risk-floor',
    ];
    const ratings = Object.fromEntries(criteria.map((criterion, index) => [criterion, {
      rating: index % 2 === 0 ? 'fail' : 'unknown',
      evidence: `${criterion} evidence `.repeat(120),
      suggestion: `${criterion} suggestion `.repeat(80),
    }]));
    const row = {
      specId: 'SPEC-22652581729405439', specRevision: 5, planItemId: 'P-001', ratings,
      requiredProofFloor: 'l4', verdict: 'fail', wouldBlock: criteria.slice(0, 3),
      scorecardDraft: {
        rubricRef: 'spec-test-adequacy', subject: { kind: 'plan', ref: 'adequacy-plan' },
        title: 'Adequacy draft', body: 'draft body '.repeat(800), ratings,
        rerunRecipe: { evaluator: 'plans:evaluate-spec-test-adequacy', args: { slug: 'adequacy-plan' } },
        terminal: true,
      },
    };
    const payload = {
      ok: true, slug: 'adequacy-plan', harnessSlug: 'papercusp',
      classRef: 'plan-class-feature-ship', rubricRef: 'spec-test-adequacy', rows: [row], count: 1,
      verdicts: { pass: 0, fail: 1, unknown: 0 },
      wouldBlock: [{ specId: row.specId, revision: row.specRevision, criteria: row.wouldBlock }],
    };
    const original = JSON.stringify(payload);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:evaluate-spec-test-adequacy', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const kept = JSON.parse((doored.content[0] as { text: string }).text) as any;
    expect(kept._projection.truncated).toBe(true);
    expect(Object.keys(kept.rows[0].ratings)).toEqual(criteria);
    expect(Object.values(kept.rows[0].ratings).every((entry: any) =>
      entry && typeof entry === 'object' && entry._partial === undefined,
    )).toBe(true);
    expect(Object.fromEntries(Object.entries(kept.rows[0].ratings).map(([key, value]: any) => [key, value.rating]))).toEqual(
      Object.fromEntries(criteria.map((criterion, index) => [criterion, index % 2 === 0 ? 'fail' : 'unknown'])),
    );
    expect(kept.rows[0]).toMatchObject({
      _partial: true,
      requiredProofFloor: 'l4',
      verdict: 'fail',
      wouldBlock: criteria.slice(0, 3),
    });
    expect(kept.verdicts).toEqual({ pass: 0, fail: 1, unknown: 0 });
    expect(kept.wouldBlock).toEqual(payload.wouldBlock);
    expect(kept._compactProjection).toMatchObject({ kind: 'evaluator-specific' });
    expect(kept.rows[0].scorecardDraft).toMatchObject({ terminal: true, rubricRef: 'spec-test-adequacy' });
    expect(kept.rows[0].scorecardDraft.body).toBeUndefined();
    expect(measureResultContextBytes(doored)).toBeLessThanOrEqual(BUDGET_CHARS);

    const control = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:list', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const controlBody = JSON.parse((control.content[0] as { text: string }).text) as any;
    expect(Object.keys(controlBody.rows[0].ratings ?? {})).not.toEqual(criteria);
  });

  it('REGRESSION (EI-22663465512565342): marker pipeline verdicts survive a generic door re-projection', () => {
    const marker = 'pipeline-marker-added-by-this-change';
    const admissions = Array.from({ length: 24 }, (_, index) => ({
      paths: [`packages/operator-core/lib/changed-${index}.ts`],
      unchanged: [`packages/operator-core/lib/unchanged-${index}.ts`],
      detail: `admission detail ${index} `.repeat(180),
    }));
    const payload = {
      input: { path: 'packages/operator-core/lib/changed.ts', sha: null },
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      positionsMarker: { marker, inMain: true, deployed: true },
      gate: {
        stalled: false,
        repairQueue: { status: 'frozen', admissions },
      },
      ...Object.fromEntries(
        Array.from({ length: 24 }, (_, index) => [`queueNoise${index}`, 'q'.repeat(900)]),
      ),
      changeInCandidate: {
        judgingSha: 'judged-sha',
        judgingShaSource: 'marker',
        judgingContainsPath: false,
        nextCandidateSha: 'next-sha',
        nextContainsPath: false,
        missingReason: 'newer-commit',
        markerJudging: { marker, present: true, count: 1 },
        markerNext: { marker, present: true, count: 1 },
        detail: 'marker settles the judged candidate and next candidate',
      },
      summary: 'pipeline summary',
    };
    const original = JSON.stringify(payload);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'dev:pipeline_position', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const kept = JSON.parse((doored.content[0] as { text: string }).text) as any;
    expect(kept._projection.truncated).toBe(true);
    expect(kept.changeInCandidate).toMatchObject({
      judgingSha: 'judged-sha',
      nextCandidateSha: 'next-sha',
      markerJudging: { marker, present: true, count: 1 },
      markerNext: { marker, present: true, count: 1 },
    });
    expect(kept.positions).toMatchObject({ inMain: false, deployed: false });
    expect(kept.positionsMarker).toMatchObject({ marker, inMain: true, deployed: true });

    // FALSIFIABILITY CONTROL: the same oversized bytes through an ordinary tool
    // have no marker-verdict policy and should still demonstrate the old drop.
    const control = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:list', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const controlBody = JSON.parse((control.content[0] as { text: string }).text) as any;
    expect(controlBody._projection.truncated).toBe(true);
    expect(controlBody.changeInCandidate).toBeUndefined();
  });

  it('preserves events:status exact-event generation state when waiter history overflows the door', () => {
    const original = JSON.stringify({
      ok: true,
      event_inspection: {
        event: 'harness:papercusp:wi-40086-qualified-current-tip',
        current_generation: 17,
        current_state: 'declared',
        declarations: [{ generation: 17, state: 'declared', note: 'qualification gate' }],
        waiters: Array.from({ length: 200 }, (_, i) => ({
          await_id: i + 1,
          subscriber_id: `su-${i}`,
          policy: 'wake',
          state: 'registered',
          registered_at: '2026-08-23T00:00:00.000Z',
          note: 'x'.repeat(320),
        })),
        wake_outcomes: [],
        resync: {
          required: false,
          reason: 'in_sync',
          consumer_generation: 17,
          authoritative_generation: 17,
        },
      },
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'events:status', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored) as ReturnType<typeof boundedBody> & {
      event_inspection?: { current_generation?: number; current_state?: string };
    };

    expect(body._projection.truncated).toBe(true);
    expect(body.event_inspection).toMatchObject({ current_generation: 17, current_state: 'declared' });
  });

  it('finds and structurally projects JSON accompanied by advisory prose', () => {
    const original = JSON.stringify({
      rows: Array.from({ length: 300 }, (_, i) => ({ id: i, detail: 'z'.repeat(100) })),
    });
    const doored = applyResultDoor(
      {
        content: [
          { type: 'text' as const, text: 'See also: work_items:claimable' },
          { type: 'text' as const, text: original },
        ],
      },
      { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const textItems = doored.content.filter((item) => (item as { type?: string }).type === 'text') as Array<{
      text: string;
    }>;
    expect(textItems).toHaveLength(1);
    expect(() => JSON.parse(textItems[0].text)).not.toThrow();
    expect(JSON.parse(textItems[0].text)._projection.cursor.tool).toBe('capability:read');
    expect(readSpill('ws-1', 'tools:invoke', RUN_ID)).toContain('See also: work_items:claimable');
  });

  it('keeps a JSON payload parseable when advisory text follows it in the MCP result', () => {
    const original = JSON.stringify({
      rows: Array.from({ length: 300 }, (_, i) => ({ id: `WI-${i}`, detail: 'x'.repeat(120) })),
    });
    const advisory = 'See also: work_items:claimable (the claim floors as a tool)';
    const doored = applyResultDoor(
      {
        content: [
          { type: 'text' as const, text: original },
          { type: 'text' as const, text: advisory },
        ],
      },
      { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored) as ReturnType<typeof boundedBody> & {
      _projection: { cursor: { bodyOffsetInPayload?: number } };
    };
    const offset = body._projection.cursor.bodyOffsetInPayload;
    expect(offset).toEqual(expect.any(Number));

    const spill = readSpill('ws-1', 'tools:invoke', RUN_ID);
    const spillBytes = Buffer.from(spill, 'utf8');
    const parsed = JSON.parse(spillBytes.subarray(offset!).toString('utf8')) as {
      rows: Array<{ id: string }>;
    };
    expect(parsed.rows).toHaveLength(300);
    expect(spill.endsWith(original)).toBe(true);

    const advisoryLine = spill
      .split('\n')
      .find((line) => line.startsWith('# advisory-text-items-json: '));
    expect(advisoryLine).toBeDefined();
    expect(JSON.parse(advisoryLine!.slice('# advisory-text-items-json: '.length))).toEqual([advisory]);
  });

  it('keeps a JSON payload parseable when advisory prose shares its text item', () => {
    const original = JSON.stringify({
      rows: Array.from({ length: 300 }, (_, i) => ({ id: `WI-${i}`, detail: 'x'.repeat(120) })),
    });
    const advisory = 'See also: work_items:observe (claimability without taking these ids)';
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: `${original}\n\n${advisory}` }] },
      { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored) as ReturnType<typeof boundedBody> & {
      _projection: { cursor: { bodyOffsetInPayload?: number } };
    };
    const spill = readSpill('ws-1', 'tools:invoke', RUN_ID);
    const parsed = JSON.parse(
      Buffer.from(spill, 'utf8').subarray(body._projection.cursor.bodyOffsetInPayload!).toString('utf8'),
    ) as { rows: Array<{ id: string }> };

    expect(parsed.rows).toHaveLength(300);
    expect(spill.endsWith(original)).toBe(true);
    expect(spill).toContain(`# advisory-text-items-json: ${JSON.stringify([advisory])}`);
  });

  it('preserves typed evidence selectors on ordinary JSON spill references', () => {
    const original = JSON.stringify({
      ok: true,
      results: Array.from({ length: 300 }, (_, i) => ({
        id: `EI-${i}`,
        workItem: { id: `EI-${i}`, state: 'open' },
        detail: 'x'.repeat(120),
      })),
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const input: DoorableResult = { content: [{ type: 'text' as const, text: original }] };
    const doored = applyResultDoor(
      input,
      { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const spillPath = (doored._meta!.resultDoor as { spillPath: string }).spillPath;
    const parsed = parseScratchReference(readFileSync(spillPath))!;

    expect(parsed.manifest.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceClass: 'work-item',
          contentIndex: 0,
          jsonPointers: expect.arrayContaining(['/results/0/workItem']),
        }),
      ]),
    );
  });

  it('preserves a degraded projection warning when structurally bounding its oversized JSON body', () => {
    const original = JSON.stringify({
      results: Array.from({ length: 300 }, (_, i) => ({
        id: `WI-${i}`,
        title: `work item ${i}`,
        detail: 'x'.repeat(120),
      })),
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    // A PARTIAL miss keeps the oversized body (the matched path still returns every
    // row) while carrying a degraded warning — the combination this test needs. An
    // ALL-miss no longer qualifies: EI-23774219620725180 made that case REFUSE with
    // a bounded key list instead of failing open into the full body, so it never
    // reaches structural bounding at all (covered in result-projection/apply.test.ts).
    const parsed = parseProjection({ pick: ['results[].id', 'results[].detail', 'results[].missing'] });
    if (!parsed.ok) throw new Error(parsed.error);
    const projected = applyResultProjection(
      { content: [{ type: 'text' as const, text: original }] },
      parsed.spec,
      { toolName: 'work_items:list', effect: 'read' },
    );
    const projectedWarning = (projected.content[0] as { text: string }).text;
    expect(projectedWarning).toMatch(/^⚠/);
    expect(projectedWarning).toContain('matched nothing');

    const doored = applyResultDoor(projected, {
      toolName: 'work_items:list',
      workspaceId: 'ws-1',
      runId: RUN_ID,
    });
    const textItems = doored.content.filter(
      (item) => (item as { type?: string }).type === 'text',
    ) as Array<{ text: string }>;

    // The warning is the first model-facing item; the bounded JSON remains a
    // separately parseable second item. The old implementation returned only
    // the latter and silently erased the degraded verdict.
    expect(textItems).toHaveLength(2);
    expect(textItems[0].text).toBe(projectedWarning);
    const bounded = JSON.parse(textItems[1].text) as {
      results: Array<Record<string, unknown>>;
      _projection: { truncated: boolean };
    };
    expect(bounded._projection.truncated).toBe(true);
    expect(measureResultContextBytes(doored)).toBeLessThanOrEqual(BUDGET_CHARS);
    expect(readSpill('ws-1', 'work_items:list', RUN_ID)).toContain('matched nothing');
  });

  it('CONTROL: a clean projection footer remains spill-only during structural bounding', () => {
    const original = JSON.stringify({
      results: Array.from({ length: 300 }, (_, i) => ({
        id: `WI-${i}`,
        detail: 'x'.repeat(120),
      })),
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const parsed = parseProjection({ pick: ['results[].detail'] });
    if (!parsed.ok) throw new Error(parsed.error);
    const projected = applyResultProjection(
      { content: [{ type: 'text' as const, text: original }] } as DoorableResult,
      parsed.spec,
      { toolName: 'work_items:list', effect: 'read' },
    );
    expect((projected._meta?.resultProjection as { notes: string[] }).notes).toEqual([]);

    const doored = applyResultDoor(projected, {
      toolName: 'work_items:list',
      workspaceId: 'ws-1',
      runId: RUN_ID,
    });
    const textItems = doored.content.filter(
      (item) => (item as { type?: string }).type === 'text',
    ) as Array<{ text: string }>;

    expect(textItems).toHaveLength(1);
    expect(textItems[0].text).not.toMatch(/^⚠/);
    expect(JSON.parse(textItems[0].text)).toMatchObject({
      _projection: { truncated: true },
    });
  });

  it('caps an unusually verbose degraded projection warning before preserving it', () => {
    const warning = `⚠ ${'warning '.repeat(400)}`;
    const original = JSON.stringify({
      results: Array.from({ length: 300 }, (_, i) => ({
        id: `WI-${i}`,
        detail: 'x'.repeat(120),
      })),
    });
    const doored = applyResultDoor(
      {
        content: [
          { type: 'text' as const, text: warning },
          { type: 'text' as const, text: original },
        ],
        _meta: { resultProjection: { applied: true, notes: ['synthetic degraded warning'] } },
      },
      { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const warningItem = doored.content.find(
      (item) => (item as { type?: string }).type === 'text' &&
        (item as { text?: string }).text?.startsWith('⚠'),
    ) as { text: string } | undefined;
    expect(warningItem?.text).toHaveLength(1_200);
    expect(warningItem?.text.startsWith('⚠')).toBe(true);
    expect(measureResultContextBytes(doored)).toBeLessThanOrEqual(BUDGET_CHARS);
  });

  it('every truncation footer teaches `projection` — the knob that would have avoided the spill (P-020)', () => {
    // The projection stage is a DISPATCH-level reserved arg, so it is in no
    // tool's inputSchema and an agent can only learn it exists from a moment
    // like this one. If this assertion is ever deleted, the feature silently
    // becomes unreachable — which is the failure this test exists to prevent.
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 3) }] },
      { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const next = boundedBody(doored)._projection.next;
    expect(next).toContain('projection:');
    expect(next).toContain('pick');
    expect(next).toContain('head');
  });

  it('D-021: mixed over-budget text/non-text is stored once behind a typed reference', () => {
    const img = { type: 'image', data: 'aaaa', mimeType: 'image/png' };
    const doored = applyResultDoor(
      {
        content: [
          { type: 'text' as const, text: longText(BUDGET_CHARS * 2) },
          img,
          { type: 'text' as const, text: 'trailing text fully over budget' },
        ],
      },
      { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    expect(doored.content).not.toContainEqual(img);
    expect(doored.content.filter((c) => (c as { type?: string }).type === 'text')).toHaveLength(1);
    const envelope = JSON.parse((doored.content[0] as { text: string }).text);
    expect(envelope).toMatchObject({
      schemaVersion: 'papercusp.output-envelope/v1',
      summaryProvenance: 'authored',
      state: 'incomplete',
      // The three blocks were RELOCATED into the spill, not dropped, so they are
      // reported as `spilledItems`; `omittedItems` is reserved for bytes that
      // were never serialized and must be absent here (EI-21954450841272611).
      incomplete: { reason: 'non-text-result-budget-exceeded', spilledItems: 3, recoverable: true },
      content: [
        {
          kind: 'reference',
          byteCount: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          expiresAt: expect.any(String),
          audience: 'workspace',
        },
      ],
    });
    expect(envelope.incomplete.note).toContain('framed scratch-reference container, not a raw JSON file');
    expect(envelope.incomplete.note).toContain('`capability:read`');
    const spill = readSpill('ws-1', 'plans:get', RUN_ID);
    expect(spill).toContain('trailing text fully over budget');
    expect(spill).toContain('"type":"image"');
    // EI-21282689413153947 recurrence guards: (a) the spill NAME must not claim
    // a strict machine format the self-describing wrapper (magic + manifest +
    // payload) breaks — a `.json` file jq cannot parse whole was the exact
    // reported failure; (b) the payload behind the canonical reader
    // (parseScratchReference, applied inside readSpill) stays parseable JSON.
    const spillDir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'plans:get', RUN_ID);
    expect(readdirSync(spillDir)[0].endsWith('.json')).toBe(false);
    expect(() => JSON.parse(spill)).not.toThrow();
  });

  it('P-029: aggregate evidence is stored once and exposed as typed per-class references', () => {
    const aggregateScope = beginResultDoorAggregate({ sessionKey: 'su-owner', outputGroupId: 'turn-evidence' });
    applyResultDoor(
      { content: [{ type: 'text' as const, text: 'prelude'.repeat(1_000) }] },
      { toolName: 'code:run', workspaceId: 'ws-1', ownerId: 'su-owner', aggregateScope },
    );
    // One aggregate cohort admits exactly two per-result door slots. Fill both
    // before the evidence-bearing third result proves the overflow route.
    applyResultDoor(
      { content: [{ type: 'text' as const, text: 'second prelude'.repeat(1_000) }] },
      { toolName: 'code:run', workspaceId: 'ws-1', ownerId: 'su-owner', aggregateScope },
    );
    const evidence = {
      workItems: [{ id: 'WI-1', state: 'done' }],
      events: [{ event: 'gate:ready', status: 'fired' }],
      fleet: { slug: 'orch-unify', alive: 3 },
      capacity: { available: 2 },
      accounts: [{ id: 'default', status: 'ready' }],
      release: { gate: 'green' },
      padding: 'x'.repeat(BUDGET_CHARS),
    };
    const result = applyResultDoor(
      { content: [{ type: 'text' as const, text: JSON.stringify(evidence) }] },
      {
        toolName: 'code:run',
        workspaceId: 'ws-1',
        ownerId: 'su-owner',
        runId: RUN_ID,
        aggregateScope,
      },
    );
    const envelope = JSON.parse((result.content[0] as { text: string }).text);
    expect(envelope.content).toEqual(
      ['work-item', 'event', 'fleet', 'capacity', 'account', 'release'].map((evidenceClass) =>
        expect.objectContaining({
          kind: 'evidence-reference',
          evidenceClass,
          uri: expect.stringContaining('/code:run/'),
        }),
      ),
    );
    expect(new Set(envelope.content.map((item: { uri: string }) => item.uri)).size).toBe(1);
    const spillDir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'code:run', RUN_ID);
    expect(readdirSync(spillDir)).toHaveLength(1);
    const parsed = parseScratchReference(readFileSync(join(spillDir, readdirSync(spillDir)[0])))!;
    expect(parsed.manifest.evidence?.map((entry) => entry.evidenceClass)).toEqual([
      'work-item', 'event', 'fleet', 'capacity', 'account', 'release',
    ]);
    expect(JSON.parse(parsed.payload.toString('utf8')).content[0].text).toBe(JSON.stringify(evidence));
  });

  it('a genuine delta ENVELOPE result (_meta.delta.mode !== "full") is NEVER doored — its text is client-parsed JSON', () => {
    const result = {
      content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      _meta: { delta: { mode: 'reconstructed' } },
    };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
  });

  it('EI-19325631662380565: a delta-CAPABLE result whose body is normal (mode:"full", reason:"no_request") IS doored', () => {
    // Regression guard: every delta-capable tool stamps `_meta.delta` on an
    // ORDINARY full response to advertise the capability + carry a cursor — the
    // mere presence of the block used to skip the door entirely for the whole
    // list-tool family (work_items:list, coord:orient, ...), the fattest
    // population the door exists to cap. `mode` is the discriminator, not presence.
    const result = {
      content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      _meta: { delta: { mode: 'full', reason: 'no_request', itemKeyField: 'id' } },
    };
    const doored = applyResultDoor(result, { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID });
    expect(doored).not.toBe(result);
    const totalChars = doored.content
      .filter((c) => (c as { type?: string }).type === 'text')
      .reduce((n, c) => n + (c as { text: string }).text.length, 0);
    expect(totalChars).toBeLessThan(longText(BUDGET_CHARS * 2).length);
    expect((doored.content.at(-1) as { text: string }).text).toContain('result-door');
  });

  it('EI-19325631662380565: a proxy-RECONSTRUCTED full body (mode:"full", reason:"proxy_reconstructed") IS doored too', () => {
    const result = {
      content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      _meta: { delta: { mode: 'full', reason: 'proxy_reconstructed' }, deltaProxy: { reconstructedFull: true } },
    };
    const doored = applyResultDoor(result, { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID });
    expect(doored).not.toBe(result);
  });

  it('kill-switch PAPERCUSP_RESULT_DOOR_OFF=1 bypasses entirely', () => {
    process.env.PAPERCUSP_RESULT_DOOR_OFF = '1';
    const result = { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }] };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
  });

  it("an unscoped caller ('*' workspace) spills under 'unscoped'; a non-UUID runId gets a fresh UUID", () => {
    const reportedRunId = 'bbc9c2b7-872b-496a-b3f4-4127e25c8e868d';
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }] },
      { toolName: 'plans:get', workspaceId: '*', runId: reportedRunId },
    );
    const pointer = (doored.content.at(-1) as { text: string }).text;
    expect(pointer).toContain('papercusp://scratch/unscoped/plans:get/');
    expect(pointer).not.toContain(reportedRunId);
    expect(pointer).toMatch(
      /papercusp:\/\/scratch\/unscoped\/plans:get\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i,
    );
  });

  it('P-023: a per-session override widens the door — the same over-baked result passes through', () => {
    const original = longText(BUDGET_CHARS * 2); // over the BAKED 1500-token door
    // The session's resolved constants double the floor → resultEach 3000 tokens.
    doorConstantsMock.mockReturnValue({ ...BAKED_DOOR_CONSTANTS, maxTurnFloorTokens: 16_000 });
    const result = { content: [{ type: 'text' as const, text: original }] };
    expect(
      applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID, ownerId: 'su-x' }),
    ).toBe(result);
    expect(doorConstantsMock).toHaveBeenCalledWith('su-x'); // keyed on the caller's identity
  });

  describe('D-021 non-text payloads share the hard output budget', () => {
    const bigImage = (chars: number) => ({
      type: 'image',
      data: 'A'.repeat(chars),
      mimeType: 'image/png',
    });

    it('spills an over-budget image and returns only a typed reference envelope', () => {
      const result: DoorableResult = {
        content: [{ type: 'text' as const, text: 'tiny caption' }, bigImage(BUDGET_CHARS * 3)],
      };
      const doored = applyResultDoor(result, {
        toolName: 'computer:screenshot',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });

      expect(doored.content).not.toContainEqual(bigImage(BUDGET_CHARS * 3));
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope.state).toBe('incomplete');
      expect(envelope.content[0]).toMatchObject({
        kind: 'reference',
        uri: expect.stringContaining('papercusp://scratch/ws-1/computer:screenshot/'),
        byteCount: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        truncated: true,
        structural: true,
        reason: 'non-text-result-budget-exceeded',
        nonTextBytes: BUDGET_CHARS * 3,
      });
      expect(readSpill('ws-1', 'computer:screenshot', RUN_ID)).toContain('tiny caption');
    });

    it('CONTROL: a SMALL non-text item keeps the identity fast-path byte-identical', () => {
      // Without this, the assertion above would also pass against a door that had
      // started appending a notice to every result carrying any non-text block —
      // which would be a regression dressed as this fix.
      const result = {
        content: [{ type: 'text' as const, text: 'small' }, bigImage(64)],
      };
      expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });

    it('counts non-text UTF-8 bytes in structural metadata when the result is doored', () => {
      const input: DoorableResult = {
        content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }, bigImage(5_000)],
      };
      const doored = applyResultDoor(input, {
        toolName: 'computer:screenshot',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const meta = (doored._meta as { resultDoor?: { nonTextBytes?: number } } | undefined)?.resultDoor;
      expect(meta?.nonTextBytes).toBe(5_000);
    });

    it('spill failure returns a bounded explicit error and never re-exposes binary data', () => {
      writeFileSync(join(sandbox, 'scratch'), 'not a directory');
      const original = bigImage(BUDGET_CHARS * 3);
      const input: DoorableResult = { content: [original] };
      const doored = applyResultDoor(input, { toolName: 'computer:screenshot', workspaceId: 'ws-1', runId: RUN_ID });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope).toMatchObject({
        state: 'error',
        error: { code: 'output_spill_failed', retryable: true },
      });
      expect((doored.content[0] as { text: string }).text).not.toContain(original.data);
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        spillFailed: true,
        spillPath: null,
        spillUri: null,
      });
    });
  });

  describe('P-006 aggregate budget spans one explicit or compatibility cohort', () => {
    const medium = (): DoorableResult => ({
      content: [{ type: 'text' as const, text: 'm'.repeat(5_000) }],
    });

    it('uses one budget across explicit fan-out and spills the result that crosses it', () => {
      const firstScope = beginResultDoorAggregate({ sessionKey: 'owner-1', outputGroupId: 'turn-7' });
      const secondScope = beginResultDoorAggregate({ sessionKey: 'owner-1', outputGroupId: 'turn-7' });
      const thirdScope = beginResultDoorAggregate({ sessionKey: 'owner-1', outputGroupId: 'turn-7' });
      const opts = { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID };

      const first = applyResultDoor(medium(), { ...opts, aggregateScope: firstScope });
      const second = applyResultDoor(medium(), { ...opts, aggregateScope: secondScope });
      const third = applyResultDoor(medium(), { ...opts, aggregateScope: thirdScope });

      expect((first._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();
      expect((second._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();
      const envelope = JSON.parse((third.content[0] as { text: string }).text);
      expect(envelope.incomplete.reason).toBe('aggregate-output-budget-exceeded');
      // EI-23761431768707969: the spill note and the batch-hint used to give OPPOSED advice (widen a
      // turn -> sibling spills; narrow it to recover -> "default to code:run" nag). The note now
      // names the way to fan out WITHOUT spending this budget, so the two read as one instruction.
      expect((third.content[0] as { text: string }).text).toContain('fold the calls into ONE code:run');
      const aggregate = (third._meta as { resultDoor?: { aggregate?: Record<string, unknown> } }).resultDoor?.aggregate;
      expect(aggregate).toMatchObject({
        mode: 'explicit',
        budgetBytes: 12_000,
        consumedBeforeBytes: 10_000,
        chargedBytes: 5_000,
        sourceBytes: 5_000,
        acceptedBytes: 2_000,
        consumedAfterBytes: 12_000,
        exceeded: true,
      });
      expect(JSON.stringify(aggregate)).not.toContain('turn-7');
      expect(readSpill('ws-1', 'plans:get', RUN_ID)).toContain('m'.repeat(100));
    });

    // EI-21954450841272611, and independently EI-21733745031882912 /
    // EI-21573289806322713 against two other tools: all three read
    // `omittedItems: N` on an aggregate spill and concluded N rows had been
    // LOST — one of them reported the underlying field as unavailable when it
    // was sitting intact in the spill. The bytes are relocated, never dropped,
    // so the envelope must not describe them with the unrecoverable word, and
    // must say what to do instead.
    it('describes an aggregate spill as recoverable and never claims omitted items', () => {
      const opts = { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID };
      const scopeFor = (id: string) => beginResultDoorAggregate({ sessionKey: 'owner-recoverable', outputGroupId: id });
      applyResultDoor(medium(), { ...opts, aggregateScope: scopeFor('turn-r') });
      applyResultDoor(medium(), { ...opts, aggregateScope: scopeFor('turn-r') });
      const overflowed = applyResultDoor(medium(), { ...opts, aggregateScope: scopeFor('turn-r') });

      const envelope = JSON.parse((overflowed.content[0] as { text: string }).text);
      expect(envelope.incomplete.reason).toBe('aggregate-output-budget-exceeded');
      // The load-bearing assertion: the unrecoverable field must be ABSENT.
      expect(envelope.incomplete).not.toHaveProperty('omittedItems');
      expect(envelope.incomplete.recoverable).toBe(true);
      expect(envelope.incomplete.spilledItems).toBe(1);
      // The note must not promise that another request in this cohort succeeds.
      expect(envelope.incomplete.note).toMatch(/explicit output cohort/i);
      expect(envelope.incomplete.note).toMatch(/new output cohort/i);
      expect(envelope.incomplete.note).toMatch(/same cohort can spill again/i);
      expect(envelope.incomplete.note).toMatch(/nothing was lost/i);
      // ...and it must not be too large on its own, which the caller cannot
      // otherwise tell apart from a genuinely oversized result.
      expect(envelope.incomplete.note).toMatch(/not too large on its own/i);
    });

    it('does not misidentify sequential compatibility requests as parallel siblings', () => {
      const opts = { toolName: 'scorecards:get', workspaceId: 'ws-1', runId: RUN_ID };
      let overflowed: DoorableResult | undefined;
      for (const startedAtMs of [1_000, 1_100, 1_200]) {
        overflowed = applyResultDoor(medium(), {
          ...opts,
          aggregateScope: beginResultDoorAggregate({ sessionKey: 'sequential-cli', startedAtMs }),
        });
      }
      const envelope = JSON.parse((overflowed!.content[0] as { text: string }).text);
      expect(envelope.incomplete.reason).toBe('aggregate-output-budget-exceeded');
      expect(envelope.incomplete.note).toMatch(/2-second compatibility cohort/i);
      expect(envelope.incomplete.note).toMatch(/does not prove they were parallel siblings/i);
    });

    // The sibling reason reaches the same route but has the OPPOSITE retry
    // advice: re-running alone spills again, so the note must not tell the
    // caller to retry.
    it('gives a non-text spill its own recovery advice rather than the aggregate one', () => {
      const doored = applyResultDoor(
        {
          content: [
            { type: 'image' as const, data: 'x'.repeat(9_000), mimeType: 'image/png' },
            { type: 'text' as const, text: 'caption' },
          ],
        } as unknown as DoorableResult,
        { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope.incomplete.reason).toBe('non-text-result-budget-exceeded');
      expect(envelope.incomplete).not.toHaveProperty('omittedItems');
      expect(envelope.incomplete.recoverable).toBe(true);
      expect(envelope.incomplete.note).toMatch(/nothing was lost/i);
      expect(envelope.incomplete.note).toMatch(/cannot be\s+sliced|cannot be sliced/i);
      expect(envelope.incomplete.note).not.toMatch(/sibling/i);
    });

    it('bounds a 35K fan-out cohort and writes every aggregate overflow as a distinct spill', () => {
      const results: DoorableResult[] = Array.from({ length: 7 }, (_, index) =>
        applyResultDoor(
          {
            content: [
              {
                type: 'text' as const,
                text: `${index}:` + String(index).repeat(4_998),
              },
            ],
          } as DoorableResult,
          {
            toolName: 'plans:get',
            workspaceId: 'ws-1',
            runId: RUN_ID,
            aggregateScope: beginResultDoorAggregate({
              sessionKey: 'owner-35k',
              outputGroupId: 'turn-35k',
            }),
          },
        ),
      );

      expect(results.reduce((sum, result) => sum + Number(
        (result._meta as { resultDoor?: { aggregate?: { sourceBytes?: number } } } | undefined)
          ?.resultDoor?.aggregate?.sourceBytes ?? 5_000,
      ), 0)).toBe(35_000);
      const spilled = results.filter((result) =>
        (result._meta as { resultDoor?: { reason?: string } } | undefined)?.resultDoor?.reason ===
        'aggregate-output-budget-exceeded',
      );
      expect(spilled).toHaveLength(5);
      expect(results.slice(0, 2).every((result) => result.content[0]?.type === 'text')).toBe(true);

      const spillDir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'plans:get', RUN_ID);
      const spillFiles = readdirSync(spillDir);
      expect(spillFiles).toHaveLength(5);
      const spillPayloads = spillFiles.map((file) => {
        const parsed = parseScratchReference(readFileSync(join(spillDir, file)));
        expect(parsed).not.toBeNull();
        return parsed!.payload.toString('utf8');
      });
      for (const index of [2, 3, 4, 5, 6]) {
        expect(spillPayloads.some((payload) => payload.includes(`${index}:${String(index).repeat(100)}`))).toBe(true);
      }
    });

    it('re-applies the hard door when a projection footer expands an otherwise fitting result', () => {
      const raw = {
        content: [{ type: 'text' as const, text: 'p'.repeat(BUDGET_CHARS - 10) }],
      };
      const direct = applyResultDoor(raw, {
        toolName: 'plans:get',
        workspaceId: 'ws-1',
        runId: '22222222-3333-4444-8555-666666666666',
      });
      expect(direct).toBe(raw);

      const parsed = parseProjection({ pipe: [{ op: 'head', n: 1 }] });
      if (!parsed.ok) throw new Error(parsed.error);
      const projected = applyResultProjection(raw, parsed.spec, { toolName: 'plans:get', effect: 'read' });
      expect(measureResultContextBytes(projected)).toBeGreaterThan(BUDGET_CHARS);

      const doored = applyResultDoor(projected, {
        toolName: 'plans:get',
        workspaceId: 'ws-1',
        runId: '22222222-3333-4444-8555-666666666666',
      });
      expect(
        ((doored as DoorableResult)._meta as { resultDoor?: { truncated?: boolean } }).resultDoor?.truncated,
      ).toBe(true);
      expect(measureResultContextBytes(doored)).toBeLessThan(measureResultContextBytes(projected));
      expect(readSpill('ws-1', 'plans:get', '22222222-3333-4444-8555-666666666666')).toContain('[projection:');
    });

    it('keeps separate explicit turns independent', () => {
      const opts = { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID };
      for (let i = 0; i < 2; i += 1) {
        applyResultDoor(medium(), {
          ...opts,
          aggregateScope: beginResultDoorAggregate({ sessionKey: 'owner-1', outputGroupId: 'turn-a' }),
        });
      }
      const other = applyResultDoor(medium(), {
        ...opts,
        aggregateScope: beginResultDoorAggregate({ sessionKey: 'owner-1', outputGroupId: 'turn-b' }),
      });
      expect((other._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();
    });

    it('declares and deterministically groups the <=2s compatibility fallback at request start', () => {
      const a = beginResultDoorAggregate({ sessionKey: 'owner-compat', startedAtMs: 1_000 });
      const b = beginResultDoorAggregate({ sessionKey: 'owner-compat', startedAtMs: 2_999 });
      const c = beginResultDoorAggregate({ sessionKey: 'owner-compat', startedAtMs: 5_001 });
      expect(a).toEqual(b);
      expect(a.mode).toBe('compatibility');
      expect(c.key).not.toBe(a.key);
    });
  });

  // WI-36047 (borrow item 9 from the opencode/OMP research). This block REPLACES
  // a test that asserted the OPPOSITE — "an unwritable scratch root returns the
  // ORIGINAL result untouched". That contract was deliberate and wrong, and the
  // test pinned it, which is why it survived: the door's cap is a side-effect of
  // "park the full copy first", so ONE `try` covered both the spill AND the cap,
  // and a failed WRITE silently inherited the cap's correct answer.
  //
  // The two failures need opposite answers. A failed CAP returning the original is
  // right. A failed SPILL returning the original re-exposes the entire payload the
  // door exists to bound — at exactly the moment the box is unhealthy (disk full,
  // unwritable scratch), and unbounded outright when the caller passed
  // payloadTier:'full' (which bypasses payload-tier's 30k ceiling upstream).
  //
  // OMP has the identical bug with the sign flipped: correct on save-FAILED
  // (output-meta.ts:684-692, truncates anyway, under a comment saying a save
  // failure must never re-expose the full output), wrong on store-ABSENT (:656,
  // returns uncapped). Same function, opposite answers — which is what makes this
  // shape worth a named guard rather than a one-line fix.
  describe('spill write fails → truncate WITHOUT recovery, never no-cap (WI-36047)', () => {
    /** A regular FILE where the scratch root dir should be → mkdirSync throws. */
    function breakScratchRoot(): void {
      writeFileSync(join(sandbox, 'scratch'), 'not a directory');
    }

    it('still CAPS the result instead of passing the full payload through', () => {
      breakScratchRoot();
      const original = longText(BUDGET_CHARS * 2);
      const result = { content: [{ type: 'text' as const, text: original }] };
      const doored = applyResultDoor(result, {
        toolName: 'plans:get',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });

      // The whole point: NOT the identity fast-path any more.
      expect(doored).not.toBe(result);
      const text = doored.content.map((c) => (c as { text?: string }).text ?? '').join('');
      // Capped: the kept body is a fraction of the original, not all of it.
      expect(text).not.toContain(original);
      expect(text.length).toBeLessThan(original.length);
    });

    it('names NO spill path in the footer — a pointer to a file that was never written is worse than none', () => {
      breakScratchRoot();
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }] },
        { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const footer = boundedBody(doored)._projection.next;

      expect(footer).toContain('spill write failed');
      expect(footer).toContain('NOT recoverable');
      // No scratch URI, no filesystem path — the reader must not spend a call
      // discovering the file is absent.
      expect(footer).not.toContain('papercusp://scratch');
      expect(footer).not.toContain(sandbox);
    });

    it('stamps the failure structurally so a machine reader is not left parsing prose', () => {
      breakScratchRoot();
      // Typed as DoorableResult, not left to inference: `applyResultDoor` returns
      // the INPUT type `T`, so a bare object literal narrows T to `{ content: … }`
      // and `doored._meta` — the very field the door stamps — is not on the type.
      const input: DoorableResult = {
        content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      };
      const doored = applyResultDoor(input, {
        toolName: 'plans:get',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const meta = (doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor;

      expect(meta?.truncated).toBe(true);
      expect(meta?.spillFailed).toBe(true);
      // null, not a string: _mcp-handler's outputRef backfill guards on spillUri
      // truthiness, so this is what stops it advertising a nonexistent artifact.
      expect(meta?.spillPath).toBeNull();
      expect(meta?.spillUri).toBeNull();
      expect(typeof meta?.spillError).toBe('string');
    });

    it('CONTROL: with a writable scratch root the same input DOES spill and DOES name a path', () => {
      // Calibration for the three tests above — without this, they would all pass
      // against a door that had simply stopped spilling entirely, which is a
      // different bug wearing this fix's clothes.
      const input: DoorableResult = {
        content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      };
      const doored = applyResultDoor(input, {
        toolName: 'plans:get',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const footer = boundedBody(doored)._projection.next;
      const meta = (doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor;

      expect(JSON.stringify(boundedBody(doored)._projection.cursor)).toContain('papercusp://scratch');
      expect(footer).not.toContain('THE OVERFLOW WAS DISCARDED');
      expect(meta?.spillFailed).toBe(false);
      expect(typeof meta?.spillPath).toBe('string');
    });
  });

  // EI-13918: `result.data` may have ALREADY been replaced upstream by a lossy
  // payload-tier projection (payload-tier.ts) before this door ever ran — in
  // which case the "FULL result is at <path>" footer is FALSE: the spilled
  // file holds only that already-partial projection, and the genuinely
  // omitted content was never serialized, so paging can never recover it.
  // `_meta.payloadProjection` (serialize-result.ts) is how the door learns
  // this without parsing the body.
  describe('upstream payload-tier truncation (_meta.payloadProjection)', () => {
    const payloadProjection = {
      truncated: true as const,
      tier: 'trimmed',
      forced: true,
      originalChars: 37343,
      returnedChars: 7058,
      omittedCount: 39,
    };

    it('does NOT claim the spill is the "FULL" result — footer + spill header say it is already-projected and unrecoverable-by-paging', () => {
      const doored = applyResultDoor(
        {
          content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 3) }],
          _meta: { payloadProjection },
        },
        { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = (doored.content.at(-1) as { text: string }).text;
      expect(pointer).not.toContain('The FULL result is at');
      expect(pointer).toContain('NOT the tool');
      expect(pointer).toContain('omittedCount=39');
      expect(pointer).toContain("payloadTier:'full'");

      const spill = readSpill('ws-1', 'coord:orient', RUN_ID);
      expect(spill).not.toContain('FULL tool result');
      expect(spill).toContain('ALREADY-PROJECTED');
      expect(spill).toContain('originalChars=37343');
      expect(spill).toContain('returnedChars=7058');
      expect(spill).toContain('NOT recoverable from this file');
    });

    it('an upstream-projected JSON spill keeps its locator and marks the body incomplete', () => {
      const text = JSON.stringify({
        rows: Array.from({ length: 300 }, (_, index) => ({ id: `row-${index}`, evidence: 'e'.repeat(80) })),
      });
      expect(text.length).toBeGreaterThan(BUDGET_CHARS);

      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }], _meta: { payloadProjection } },
        { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const body = boundedBody(doored) as {
        _projection: {
          cursor: { bodyOffsetInPayload?: number; bodyComplete?: boolean };
          next: string;
        };
      };

      expect(body._projection.cursor.bodyOffsetInPayload).toEqual(expect.any(Number));
      expect(body._projection.cursor.bodyComplete).toBe(false);
      expect(body._projection.next).toContain('upstream payloadProjection');
      expect(body._projection.next).toContain('this JSON is partial (bodyComplete:false)');
      expect(body._projection.next).toContain('paging cannot recover omitted fields');
      expect(body._projection.next).toContain("Re-call coord:orient with payloadTier:'full'");
    });

    it(
      'a result WITHOUT any marker gets the HONEST default wording — never an unconditional ' +
        '"FULL result" claim (EI-18762253154342502: no marker firing proves nothing was cut ' +
        'upstream, only that no known marker fired — a tool can silently truncate a field with ' +
        'a bare ellipsis and no `_truncated` flag, as plans:items did before its own fix)',
      () => {
        const doored = applyResultDoor(
          { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 3) }] },
          { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
        );
        const pointer = boundedBody(doored)._projection.next;
        expect(pointer).not.toContain('The FULL result is at');
        expect(pointer).toMatch(/JSON starts after cursor\.bodyOffsetInPayload|the spill opens with a text header/);
        expect(pointer).toContain('No upstream truncation marker was detected');
        const spill = readSpill('ws-1', 'plans:get', RUN_ID);
        expect(spill).not.toContain('# result-door spill — FULL tool result');
        expect(spill).toContain('# result-door spill — the text as it reached this door');
      },
    );

    // EI-19361771982678588: a partial source now takes the typed incomplete
    // route even when its emitted body fits the per-result byte budget.
    it('an under-budget upstream projection returns an incomplete envelope and keeps the emitted body inspectable', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'small already-projected result' }],
        _meta: { payloadProjection },
      };
      const doored = applyResultDoor(result, { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(doored.content).toHaveLength(1);
      expect(envelope).toMatchObject({
        schemaVersion: 'papercusp.output-envelope/v1',
        state: 'incomplete',
        incomplete: { reason: 'under-budget-partial-result', recoverable: false },
        content: [{ kind: 'reference', uri: expect.stringContaining('papercusp://scratch/ws-1/coord:orient/') }],
      });
      expect(envelope.incomplete.note).toContain('lossy upstream projection');
      expect(envelope.incomplete.note).toContain("payloadTier:'full'");
      expect(readSpill('ws-1', 'coord:orient', RUN_ID)).toContain('small already-projected result');
    });

    it('an UNtruncated small result keeps the identity fast-path (no note, no copy)', () => {
      const result = { content: [{ type: 'text' as const, text: 'small result' }] };
      expect(applyResultDoor(result, { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });

    it('a small result whose marker says truncated:false also keeps the fast-path', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'small result' }],
        _meta: { payloadProjection: { ...payloadProjection, truncated: false as unknown as true } },
      };
      expect(applyResultDoor(result, { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });

    it.each([
      [
        'array row',
        JSON.stringify({ rows: [{ id: 'row-1', _partial: true, title: 'visible row' }] }),
        '_partial',
      ],
      [
        'keyed map',
        JSON.stringify({ ratings: { criterionA: { rating: 'pass' }, _partial: true } }),
        '_partial',
      ],
      [
        'clipped string',
        JSON.stringify({ evidence: 'evidence prefix…[TRUNCATED +17 chars — re-read with payloadTier:full]' }),
        'textTruncated',
      ],
    ] as const)('returns an incomplete envelope for an under-budget %s marker', (_shape, text, marker) => {
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(BUDGET_CHARS);
      const input: DoorableResult = { content: [{ type: 'text' as const, text }] };
      const doored = applyResultDoor(
        input,
        { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope).toMatchObject({
        schemaVersion: 'papercusp.output-envelope/v1',
        state: 'incomplete',
        incomplete: { reason: 'under-budget-partial-result', recoverable: false },
        content: [{ kind: 'reference', uri: expect.stringContaining('papercusp://scratch/ws-1/plans:get/') }],
      });
      expect(envelope.incomplete.note).toContain('paging this reference cannot recover');
      expect((doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor).toMatchObject({
        innerTruncationMarkers: [marker],
      });
      const spill = JSON.parse(readSpill('ws-1', 'plans:get', RUN_ID)) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(spill.content[0].text).toBe(text);
    });

    it('does not treat an escaped partial-marker example inside a JSON string as a real marker', () => {
      const result = {
        content: [{ type: 'text' as const, text: JSON.stringify({ note: 'Example syntax: "_partial": true' }) }],
      };
      expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });
  });

  // EI-22167228731928620: an EXPLICIT payloadTier:'full' request (or an
  // equivalent transport-cap exemption) that still overflows the transport
  // door must not be handed a WORSE result than a plain 'trimmed' call would
  // have produced. `_meta.explicitFullRequest` (serialize-result.ts, set by
  // payload-tier.ts's explicitFullRequest exempt path) tells the door this
  // body is the tool's true raw, unshaped output — the door spills it whole
  // and points at it instead of re-projecting it with the generic,
  // field-blind bounded-payload walk.
  describe('explicit full-request overflow (_meta.explicitFullRequest)', () => {
    const RUN_ID_2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';

    it('spills the RAW body whole and returns a clean reference envelope instead of a generic re-projection', () => {
      // A flat repeated-char body, not `longText()` — the reference envelope's
      // spill JSON-stringifies the whole `content` array as ONE nested string,
      // so a body containing newlines would appear ESCAPED (`\\n`) in the spill
      // file and never substring-match the raw multi-line original.
      const original = 'X'.repeat(BUDGET_CHARS * 3);
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }], _meta: { explicitFullRequest: true } },
        { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope.state).toBe('incomplete');
      expect(envelope.incomplete).toMatchObject({ reason: 'explicit-full-request-overflow', recoverable: true });
      expect(envelope.incomplete.note).toContain("payloadTier:'full'");
      expect(envelope.content[0]).toMatchObject({
        kind: 'reference',
        uri: expect.stringContaining('papercusp://scratch/ws-1/work_items:get/'),
        byteCount: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(readSpill('ws-1', 'work_items:get', RUN_ID)).toContain(original);
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        truncated: true,
        structural: true,
        reason: 'explicit-full-request-overflow',
      });
    });

    it('marks a hard spill non-recoverable when the tool already truncated a field', () => {
      const text = JSON.stringify({
        results: [{
          id: 'WI-1',
          checkpoint: 'checkpoint prefix…[TRUNCATED +1200 chars — re-read with payloadTier:\'full\']',
          textTruncated: true,
          padding: 'P'.repeat(BUDGET_CHARS * 3),
        }],
      });
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }], _meta: { explicitFullRequest: true } },
        { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope.incomplete).toMatchObject({
        reason: 'explicit-full-request-overflow',
        spilledItems: 1,
        recoverable: false,
      });
      expect(envelope.incomplete.note).toContain('upstream partial marker(s)');
      expect(envelope.incomplete.note).toContain('textTruncated');
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        upstreamProjected: false,
        innerTruncationMarkers: ['textTruncated'],
      });
      expect(readSpill('ws-1', 'work_items:get', RUN_ID)).toContain('checkpoint prefix');
    });

    it('a small explicit-full body that FITS the door passes through untouched (no spill, no note)', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'small full result' }],
        _meta: { explicitFullRequest: true },
      };
      expect(applyResultDoor(result, { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(
        result,
      );
    });

    it(
      'regression: an over-budget explicit-full body is never WORSE than the generic reprojection of the ' +
        "SAME body without the marker — the concrete repro was a `summary` field the tool's own shaper " +
        'would prioritize getting crowded out by sibling raw fields once that shaper is skipped for `full`',
      () => {
        const body = { summary: 'S'.repeat(4_000), extra: 'E'.repeat(BUDGET_CHARS * 2) };
        const text = JSON.stringify(body);
        expect(text.length).toBeGreaterThan(BUDGET_CHARS);

        // Un-marked: takes the generic bounded-payload walk (pre-existing behavior).
        const generic = applyResultDoor(
          { content: [{ type: 'text' as const, text }] },
          { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID_2 },
        );
        const genericProjected = JSON.parse((generic.content[0] as { text: string }).text) as { summary?: string };
        const genericSummaryChars = genericProjected.summary?.length ?? 0;
        // The field-blind walk is not guaranteed to keep the whole 4,000-char
        // field — asserting it here pins down the actual defect this fix
        // addresses (it does NOT keep it in full for this shape).
        expect(genericSummaryChars).toBeLessThan(4_000);

        // Marked: routes to the hard-overflow spill instead of that walk.
        const marked = applyResultDoor(
          { content: [{ type: 'text' as const, text }], _meta: { explicitFullRequest: true } },
          { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
        );
        const envelope = JSON.parse((marked.content[0] as { text: string }).text);
        expect(envelope.incomplete.reason).toBe('explicit-full-request-overflow');
        // The FULL summary — and everything else — is recoverable in full from
        // the spill: strictly more than whatever fraction the generic walk
        // kept inline, never worse.
        expect(readSpill('ws-1', 'work_items:get', RUN_ID)).toContain('S'.repeat(4_000));
      },
    );
  });

  // EI-18745696571494110: a tool with no `_meta.payloadProjection` can still have
  // truncated an individual FIELD inside its own body (coord:inbox's per-entry
  // `body_truncated`) — the door has no structured signal for this (each tool
  // bakes its own field-level cutoff into the serialized body), so it must detect
  // the generic `"<name>_truncated": true` shape textually and stop telling the
  // reader to page a spill that can never contain what the tool never serialized.
  describe('tool-internal field truncation (no _meta marker — detected in the body text)', () => {
    /** Prepends a small JSON snippet carrying the marker, then pads with `longText`
     *  past the door budget so the door actually spills (detection only matters
     *  on the over-budget path). */
    function withMarker(markerJson: string, totalChars: number): string {
      return markerJson + longText(Math.max(0, totalChars - markerJson.length));
    }

    it('a body_truncated:true marker swaps the footer to "re-call the tool", not "page the spill"', () => {
      const text = withMarker('{"entries":[{"id":"m1","body_truncated":true}]}\n', BUDGET_CHARS * 3);
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'coord:inbox', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      expect(pointer).not.toContain('page it with a bounded read');
      expect(pointer).toContain('TOOL ITSELF already truncated');
      expect(pointer).toContain('body_truncated');
      expect(pointer).toContain('Re-call coord:inbox');

      const spill = readSpill('ws-1', 'coord:inbox', RUN_ID);
      expect(spill).toContain('TOOL ITSELF already truncated');
      expect(spill).toContain('body_truncated');
      expect(spill).not.toContain('# result-door spill — FULL tool result\n');
    });

    it('several distinct *_truncated markers are all named, deduplicated', () => {
      const text = withMarker(
        '{"a":{"summary_truncated":true},"b":{"body_truncated":true},"c":{"body_truncated":true}}\n',
        BUDGET_CHARS * 3,
      );
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'plans:items', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      expect(pointer).toContain('summary_truncated');
      expect(pointer).toContain('body_truncated');
      // deduped: body_truncated appears twice in the source but once in the marker list
      expect(pointer.match(/body_truncated/g)).toHaveLength(1);
    });

    it('camelCase *Truncated markers from build:typecheck TOON output are detected', () => {
      const text = withMarker(
        'errorsTruncated: true\nbyFileTruncated: true\n',
        BUDGET_CHARS * 3,
      );
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'build:typecheck', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      expect(pointer).toContain('TOOL ITSELF already truncated');
      expect(pointer).toContain('errorsTruncated');
      expect(pointer).toContain('byFileTruncated');
      expect(pointer).toContain('Re-call build:typecheck');
    });

    it('code:run summaryNotice.truncated marks its JSON spill partial and recommends smaller returns', () => {
      const text = JSON.stringify({
        summary: 'S'.repeat(3_500),
        summaryNotice: { truncated: true, originalChars: 9_296, returnedChars: 3_500 },
        padding: 'P'.repeat(BUDGET_CHARS * 3),
      });
      const input: DoorableResult = { content: [{ type: 'text' as const, text }] };
      const doored = applyResultDoor(
        input,
        { toolName: 'code:run', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      const spill = readSpill('ws-1', 'code:run', RUN_ID);

      expect(pointer).toContain('source is already partial');
      expect(pointer).toContain('summaryNotice.truncated');
      expect(pointer).toContain('smaller return');
      expect(pointer).toContain('bounded slices');
      expect(spill).toContain('summaryNotice.truncated');
      expect(spill).toContain('smaller return');
      expect((doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor).toMatchObject({
        innerTruncationMarkers: ['summaryNotice.truncated'],
      });
    });

    it('summaryNotice.truncated:false is not treated as a partial-result marker', () => {
      const text = JSON.stringify({
        summary: 'S'.repeat(3_500),
        summaryNotice: { truncated: false, originalChars: 3_500, returnedChars: 3_500 },
        padding: 'P'.repeat(BUDGET_CHARS * 3),
      });
      const input: DoorableResult = { content: [{ type: 'text' as const, text }] };
      const doored = applyResultDoor(
        input,
        { toolName: 'code:run', workspaceId: 'ws-1', runId: RUN_ID },
      );

      expect(boundedBody(doored)._projection.next).not.toContain('source is already partial');
      expect((doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor).toMatchObject({
        innerTruncationMarkers: [],
      });
    });

    it('a *_truncated:false field is NOT mistaken for a truncation marker', () => {
      const text = withMarker('{"entries":[{"id":"m1","body_truncated":false}]}\n', BUDGET_CHARS * 3);
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'coord:inbox', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      // The recovery footer is "JSON starts after cursor.bodyOffsetInPayload…" when the body parses
      // as JSON, else "the spill opens with a text header." (the literal `recover spill;` lead-in was
      // dropped by the Codex no-base64 pointer rewrite) — either way a recovery footer must be present.
      expect(pointer).toMatch(/JSON starts after cursor\.bodyOffsetInPayload|the spill opens with a text header/);
      expect(pointer).not.toContain('TOOL ITSELF already truncated');
    });

    it('upstream payloadProjection takes priority over a body-level marker when both are present', () => {
      const text = withMarker('{"entries":[{"id":"m1","body_truncated":true}]}\n', BUDGET_CHARS * 3);
      const doored = applyResultDoor(
        {
          content: [{ type: 'text' as const, text }],
          _meta: {
            payloadProjection: {
              truncated: true as const,
              tier: 'trimmed',
              forced: true,
              originalChars: 50_000,
              returnedChars: 8_000,
              omittedCount: 12,
            },
          },
        },
        { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = (doored.content.at(-1) as { text: string }).text;
      expect(pointer).toContain('ALREADY tier-projected upstream');
      expect(pointer).not.toContain('TOOL ITSELF already truncated');
    });

    it('a true truncation marker under the door budget returns an incomplete envelope', () => {
      const result = {
        content: [{ type: 'text' as const, text: '{"entries":[{"id":"m1","body_truncated":true}]}' }],
      };
      const doored = applyResultDoor(result, { toolName: 'coord:inbox', workspaceId: 'ws-1', runId: RUN_ID });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope).toMatchObject({
        state: 'incomplete',
        incomplete: { reason: 'under-budget-partial-result', recoverable: false },
      });
      expect(envelope.incomplete.note).toContain('body_truncated');
    });
  });
});

/**
 * D-012 (plan agent-context-firewall-and-output-spill-2026-08-02) — the spill
 * footer must be a FUNCTION of the payload, not a constant.
 *
 * The bug this replaces: the footer led with `pipe` "for text" on EVERY result,
 * including the one-line JSON bodies that are most of what this door cuts —
 * where the line operators are provably all-or-nothing and a `grep` no-match
 * returns an empty body that reads like a successful filter
 * (EI-19387749343846381).
 *
 * TEETH: these do not merely assert today's wording. Every case drives the door
 * with a DIFFERENT body shape and requires the output to FOLLOW it, and the
 * third case uses a payload placement that only the shared
 * `classifyProjectionBody` finds — a re-hardcoded `JSON.parse(joined)`
 * classifier passes the first two and fails that one.
 */
describe('buildProjectionHint — D-012 payload-aware spill footer', () => {
  /** A COMPACT (single-line) JSON object over `chars` — the shape this door cuts most. */
  function longJson(chars: number): string {
    const rows: Array<Record<string, string>> = [];
    while (JSON.stringify({ items: rows }).length < chars) {
      rows.push({ id: `WI-${rows.length}`, state: 'open', title: 'a work item title with some length to it' });
    }
    return JSON.stringify({ items: rows });
  }

  function footerFor(content: Array<{ type: 'text'; text: string }>, toolName = 'work_items:list'): string {
    const doored = applyResultDoor({ content }, { toolName, workspaceId: 'ws-1', runId: RUN_ID });
    return boundedBody(doored)._projection.next;
  }

  it('a JSON body leads with `pick` and states that `pipe` cannot reduce it', () => {
    const footer = footerFor([{ type: 'text', text: longJson(BUDGET_CHARS * 2) }]);
    expect(footer).toContain('`pick` is what reduces it');
    expect(footer).toContain('all-or-nothing');
    expect(footer).toContain('1 line(s)');
    // The actual defect was ORDER: the pipe form was advertised first.
    expect(footer.indexOf('pick')).toBeLessThan(footer.indexOf('pipe'));
    // The operator list belongs to the text variant only — it is dead weight here.
    expect(footer).not.toContain('grep (fixed/ignoreCase');
    // The constant this replaced said exactly this; its return would be a regression.
    expect(footer).not.toContain('for text, or');
  });

  it('a multi-line non-JSON body offers the `pipe` operators and says `pick` does not apply', () => {
    const footer = footerFor([{ type: 'text', text: longText(BUDGET_CHARS * 2) }], 'capability:bash');
    expect(footer).toContain('op:"grep"');
    expect(footer).toContain('lines of non-JSON text');
    expect(footer).toContain('`pick` does not apply');
    expect(footer).toContain('grep (fixed/ignoreCase');
  });

  it('finds the JSON payload even when it is neither the joined body nor the first item', () => {
    // The live shape: a JSON payload accompanied by advisory prose, so the
    // JOINED text does not parse. A classifier that only tries the join — or
    // only the first item — calls this "text" and emits the wrong operator.
    const footer = footerFor([
      { type: 'text', text: 'See also: work_items:claimable (the claim floors as a tool)' },
      { type: 'text', text: longJson(BUDGET_CHARS * 2) },
    ]);
    expect(footer).toContain('`pick` is what reduces it');
    expect(footer).not.toContain('lines of non-JSON text');
  });

  it('does not advertise `pipe` on a body it just wrote to the spill AS JSON (EI-20071580479842384)', () => {
    // The seam the separate-item test above does NOT reach: the advisory rides
    // in the SAME text item as the payload, so `classifyProjectionBody` misses
    // on both the join and the per-item pass. The spill writer still recovers
    // the payload via `findJsonPrefixSlice` — and the footer used to re-derive
    // the shape with only the weaker half, so ONE string claimed both "JSON
    // starts after cursor.bodyOffsetInPayload" and "`pick` does not apply here".
    // That sent the reader to `pipe`, which on a JSON body is the all-or-nothing
    // trap this very hint exists to warn about.
    const footer = footerFor([
      { type: 'text', text: `${longJson(BUDGET_CHARS * 2)}\n\nSee also: work_items:claimable (the claim floors as a tool)` },
    ]);
    expect(footer).toContain('JSON starts after cursor.bodyOffsetInPayload');
    expect(footer).toContain('`pick` is what reduces it');
    expect(footer).not.toContain('lines of non-JSON text');
    expect(footer).not.toContain('`pick` does not apply');
  });

  it('honors a caller-supplied classification over re-deriving a weaker one', () => {
    // Unit-level falsifier for the wiring itself: same textItems, opposite
    // advice, decided solely by the shape the caller already acted on.
    const sameItemSuffix = [{ text: '{"items":[{"id":"WI-1"}]}\n\nSee also: work_items:list' }];
    expect(buildProjectionHint(sameItemSuffix, 'work_items:list')).toContain('non-JSON text');
    expect(
      buildProjectionHint(sameItemSuffix, 'work_items:list', {
        json: { parsed: { items: [{ id: 'WI-1' }] }, itemIndex: 0 },
        lineCount: 3,
      }),
    ).toContain('`pick` is what reduces it');
  });

  it('a single-line non-JSON body says projection cannot help, and names the tool to re-call', () => {
    const footer = footerFor([{ type: 'text', text: 'x'.repeat(BUDGET_CHARS * 2) }], 'capability:read');
    expect(footer).toContain('`projection` cannot help');
    expect(footer).toContain('capability:read');
    expect(footer).not.toContain('op:"grep"');
  });

  it('the hint is derived from the body, not fixed: the same tool gets DIFFERENT advice for JSON vs text', () => {
    const jsonHint = buildProjectionHint([{ text: '{"a":1}' }], 'plans:get');
    const textHint = buildProjectionHint([{ text: 'line one\nline two\nline three' }], 'plans:get');
    expect(jsonHint).not.toEqual(textHint);
    expect(jsonHint).toContain('pick');
    expect(jsonHint).toContain('1 line(s)');
    expect(textHint).toContain('3 lines of non-JSON text');
    // Reader-capability leg: the reachable form for a schema-driven client.
    expect(jsonHint).toContain('JSON STRING');
    expect(textHint).toContain('JSON STRING');
  });

  it('fails soft to payload-agnostic wording rather than losing the hint', () => {
    // A getter that throws stands in for any future classifier fault; the door's
    // contract is that a hint problem never costs the caller the footer.
    const hostile = [
      {
        get text(): string {
          throw new Error('boom');
        },
      },
    ] as unknown as Array<{ text: string }>;
    const hint = buildProjectionHint(hostile, 'plans:get');
    expect(hint).toContain('pick');
    expect(hint).toContain('pipe');
  });
});
