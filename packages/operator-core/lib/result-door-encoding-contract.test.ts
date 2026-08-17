/**
 * result-door-encoding-contract.test.ts — EI-20685195115158619.
 *
 * The spill cursor's recovery instruction is the ONLY guidance an agent has at
 * the moment it hits a capped result, and it is load-bearing: a spilled payload
 * is exactly the situation where an agent is trying to recover authoritative
 * in-flight state and cannot afford a detour.
 *
 * The reported defect was that the cursor "declares base64 but the file is
 * plaintext". The declaration is in fact CORRECT — but about the RESPONSE of the
 * prescribed `capability:read` call, not about the file on disk. A bare
 * `encoding: 'base64'` sitting beside `file_path` invited the other reading, and
 * an agent that took it ran `base64 -d <path>`, got `invalid input`, and burned
 * calls. Worse: `base64 -d` on plaintext exits NON-ZERO with EMPTY stdout, so a
 * piped attempt reads as "the spill is empty" rather than "my decoder was wrong"
 * — an absence-vs-broken-instrument confusion arriving through the recovery path.
 *
 * So this suite pins the CONTRACT rather than either half of it, by following
 * the emitted cursor end-to-end through the real `capability:read` handler. It
 * fails in all four drift directions: the door writing base64 to disk, the read
 * tool ceasing to base64 its `data`, the cursor regaining an unscoped `encoding`
 * field, or the prose losing the disambiguation.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE } from './context-doors';

// Same seam as result-door.test.ts: the door resolves its constants through the
// config surface per call, so stub it to keep this suite PG-free.
const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('./context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import type { DoorableResult } from './result-door';
import { applyResultDoor, RESULT_DOOR_TOKENS } from './result-door';
import readTool from './agent-tools/capability/read';

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const RUN_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const WS = 'ws-encoding-contract';
const TOOL = 'work_items:get';

let sandbox: string;
let prevScratchRoot: string | undefined;
let prevKillSwitch: string | undefined;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-door-encoding-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  prevKillSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
  delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  if (prevKillSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  else process.env.PAPERCUSP_RESULT_DOOR_OFF = prevKillSwitch;
  rmSync(sandbox, { recursive: true, force: true });
});

type SpillCursor = {
  kind: string;
  tool: string;
  args: { file_path: string; byte_offset: number; byte_limit: number };
  uri?: string;
  encoding?: unknown;
  responseDataEncoding?: string;
  spillFileEncoding?: string;
};

/** Drive a payload over the door and return its recovery cursor + prose. */
function doorOversizedResult(): { cursor: SpillCursor; next: string } {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    id: `WI-${i}`,
    state: 'open',
    detail: `detail ${i} — `.repeat(20),
  }));
  const text = JSON.stringify({ ok: true, rows });
  expect(text.length).toBeGreaterThan(BUDGET_CHARS);

  const doored = applyResultDoor(
    { content: [{ type: 'text' as const, text }] },
    { toolName: TOOL, workspaceId: WS, runId: RUN_ID },
  ) as DoorableResult;

  const body = JSON.parse(
    (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text,
  ) as { _projection: { cursor: SpillCursor; next: string } };

  expect(body._projection.cursor.kind).toBe('scratch-page');
  return { cursor: body._projection.cursor, next: body._projection.next };
}

/** The single spill file the door wrote, as RAW BYTES (never utf8-decoded — the
 *  whole question here is what the bytes on disk actually are). */
function spillBytes(): Buffer {
  const dir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, WS, TOOL, RUN_ID);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]));
}

describe('EI-20685195115158619: spill cursor encoding contract', () => {
  it('scopes each encoding to what it describes, with no unscoped `encoding` field', () => {
    const { cursor } = doorOversizedResult();

    expect(cursor.responseDataEncoding).toBe('base64');
    expect(cursor.spillFileEncoding).toBe('utf-8');
    // The exact field that caused the misread: unscoped, and adjacent to
    // `file_path`, it reads as a property of the file. It must not come back.
    expect(cursor).not.toHaveProperty('encoding');
  });

  it('names the field to decode by its OWNER, not as a bare `data`', () => {
    const { next } = doorOversizedResult();

    // A bare "base64-decode data" is what left the reporter decoding the file.
    expect(next).toContain('response.data');
    // WI-5656: this is the JSON branch, whose pointer is budgeted together with
    // the retained preview — the fuller prose warning must NOT appear here. A
    // ~90-char addition measurably evicted coord:orient's recovery fields.
    expect(next).not.toContain('grep/tail it directly');
  });

  it('carries the full plaintext warn-off on the raw-text branch, which has budget', () => {
    // Non-JSON body: the `{ text, _projection }` envelope, where the fuller
    // honesty wording already lives and the preview budget is not at stake.
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: 'not json — '.repeat(4_000) }] },
      { toolName: 'code:tools', workspaceId: WS, runId: RUN_ID },
    ) as DoorableResult;
    const body = JSON.parse(
      (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text,
    ) as { _projection: { next: string } };

    expect(body._projection.next).toContain('response.data');
    // The hazard itself: `base64 -d` on plaintext exits non-zero with EMPTY
    // stdout, which reads as an empty spill rather than a wrong decoder.
    expect(body._projection.next).toContain('plaintext');
    expect(body._projection.next).toContain('base64 -d');
    expect(body._projection.next).toContain('fails EMPTY');
  });

  it('writes the spill as PLAINTEXT — the file is greppable, not base64', () => {
    doorOversizedResult();
    const bytes = spillBytes();
    const text = bytes.toString('utf8');

    expect(text.startsWith('# result-door spill')).toBe(true);
    // Positive proof of plaintext rather than a lenient decode round-trip:
    // the header carries characters that cannot occur in base64 at all.
    expect(text.slice(0, 200)).toMatch(/[#\s]/);
    expect(/^[A-Za-z0-9+/\r\n=]*$/.test(text)).toBe(false);
  });

  it('follows the emitted cursor end-to-end through the real capability:read', async () => {
    const { cursor } = doorOversizedResult();
    expect(cursor.tool).toBe('capability:read');

    // Execute the instruction exactly as an agent would: the cursor's own args,
    // through the actual tool handler — no re-implementation of the byte window.
    const res = (await readTool.handler(cursor.args as never, { projectDir: sandbox } as never)) as {
      content: Array<{ text: string }>;
    };
    const page = JSON.parse(res.content[0].text) as {
      ok: boolean;
      encoding: string;
      byte_length: number;
      data: string;
      eof: boolean;
    };

    expect(page.ok).toBe(true);
    // The RESPONSE is where base64 is real — this is what the cursor declares.
    expect(page.encoding).toBe(cursor.responseDataEncoding);
    expect(page.encoding).toBe('base64');

    const decoded = Buffer.from(page.data, 'base64');
    expect(decoded.equals(spillBytes().subarray(0, page.byte_length))).toBe(true);
    expect(decoded.toString('utf8').startsWith('# result-door spill')).toBe(true);
  });
});
