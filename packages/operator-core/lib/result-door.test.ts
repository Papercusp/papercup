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
    expect(parsed._projection.next).toContain('follow next_cursor until eof');
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
      incomplete: { reason: 'non-text-result-budget-exceeded', omittedItems: 3 },
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
    const spill = readSpill('ws-1', 'plans:get', RUN_ID);
    expect(spill).toContain('trailing text fully over budget');
    expect(spill).toContain('"type":"image"');
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
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }] },
      { toolName: 'plans:get', workspaceId: '*', runId: 'not-a-uuid' },
    );
    const pointer = (doored.content.at(-1) as { text: string }).text;
    expect(pointer).toContain('papercusp://scratch/unscoped/plans:get/');
    expect(pointer).not.toContain('not-a-uuid');
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
        expect(pointer).toContain('recover the exact spill bytes');
        expect(pointer).toContain('No upstream truncation marker was detected');
        const spill = readSpill('ws-1', 'plans:get', RUN_ID);
        expect(spill).not.toContain('# result-door spill — FULL tool result');
        expect(spill).toContain('# result-door spill — the text as it reached this door');
      },
    );

    // EI-19361771982678588 — this case USED to assert `toBe(result)` (byte
    // identity). That was stronger than its own stated intent: what must not
    // happen is a false-positive SPILL, and no spill is still written here.
    // But returning the body untouched also meant a result that was
    // tier-trimmed and THEN landed under the door said NOTHING about being
    // partial — every truncation disclosure in this file is downstream of the
    // fits-the-budget early return. So the harder a tool trimmed itself, the
    // likelier it was to go silent: the warning fired only when the
    // already-trimmed body still overflowed. Measured on the facts:list case
    // that motivated this, the margin was 245 chars out of ~6,000.
    it('a projected result that fits the door writes NO spill, but still DISCLOSES that it is partial', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'small already-projected result' }],
        _meta: { payloadProjection },
      };
      const doored = applyResultDoor(result, { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID });

      // The original intent, unchanged: fitting the budget must never spill.
      expect(() => readdirSync(join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'coord:orient', RUN_ID))).toThrow();

      // The body itself is preserved verbatim — only a disclosure is appended.
      expect((doored.content[0] as { text: string }).text).toBe('small already-projected result');
      const note = (doored.content.at(-1) as { text: string }).text;
      expect(note).toContain('PARTIAL RESULT');
      expect(note).toContain('omittedCount=39');
      expect(note).toContain('ABSENCE HERE IS NOT EVIDENCE');
      expect(note).toContain("payloadTier:'full'");
      expect(note).toContain('coord:orient');
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

    it('a *_truncated:false field is NOT mistaken for a truncation marker', () => {
      const text = withMarker('{"entries":[{"id":"m1","body_truncated":false}]}\n', BUDGET_CHARS * 3);
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'coord:inbox', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      expect(pointer).toContain('recover the exact spill bytes');
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

    it('a marker present but under the door budget is untouched (no false-positive spill)', () => {
      const result = {
        content: [{ type: 'text' as const, text: '{"entries":[{"id":"m1","body_truncated":true}]}' }],
      };
      expect(applyResultDoor(result, { toolName: 'coord:inbox', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
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
  /** A COMPACT (single-line) JSON array over `chars` — the shape this door cuts most. */
  function longJson(chars: number): string {
    const rows: Array<Record<string, string>> = [];
    while (JSON.stringify(rows).length < chars) {
      rows.push({ id: `WI-${rows.length}`, state: 'open', title: 'a work item title with some length to it' });
    }
    return JSON.stringify(rows);
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
