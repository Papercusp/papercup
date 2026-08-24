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
import { parseScratchReference } from './scratch-reference';

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
  maxByteLimit?: number;
  uri?: string;
  encoding?: unknown;
  dataEncoding?: string;
  /** Offset of the JSON body within capability:read's returned `response.data`
   *  (the manifest is already stripped there). */
  bodyOffsetInPayload?: number;
  /** Offset of the JSON body within the RAW on-disk file at `args.file_path`
   *  (manifest header included) — the shell / jq / grep audience. */
  bodyOffsetInFile?: number;
  /** Present and false when the tool clipped fields before this door ran. */
  bodyComplete?: boolean;
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

/** A valid JSON result whose tool-owned record body is already clipped. */
function doorOversizedPartialJsonResult(): { cursor: SpillCursor; next: string } {
  const records = Array.from({ length: 11 }, (_, i) =>
    `### D-${String(i + 1).padStart(3, '0')}\n${'decision text '.repeat(80)}`,
  ).join('\n\n');
  const text = JSON.stringify({
    ok: true,
    results: [{
      section: {
        heading: 'Decisions',
        level: 2,
        body: records,
        body_truncated: true,
        body_full_chars: records.length + 10_000,
        body_records_shown: 11,
        body_records_total: 22,
      },
    }],
  });
  expect(text.length).toBeGreaterThan(BUDGET_CHARS);

  const doored = applyResultDoor(
    { content: [{ type: 'text' as const, text }] },
    { toolName: TOOL, workspaceId: WS, runId: RUN_ID },
  ) as DoorableResult;
  const body = JSON.parse(
    (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text,
  ) as { _projection: { cursor: SpillCursor; next: string } };
  return { cursor: body._projection.cursor, next: body._projection.next };
}

/** The unwrapped spill payload returned by capability:read (without the
 *  self-describing manifest header). */
function spillBytes(): Buffer {
  const dir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, WS, TOOL, RUN_ID);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const reference = parseScratchReference(readFileSync(join(dir, files[0])));
  expect(reference).not.toBeNull();
  return reference!.payload;
}

/** The exact bytes on disk at the cursor's file_path, including its manifest. */
function spillRawBytes(): Buffer {
  const dir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, WS, TOOL, RUN_ID);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]));
}

describe('EI-20685195115158619: spill cursor encoding contract', () => {
  it('binds the encoding key to the field it describes, not to the file', () => {
    const { cursor } = doorOversizedResult();

    expect(cursor.dataEncoding).toBe('base64');
    // The exact field that caused the misread: unscoped, and adjacent to
    // `file_path`, it reads as a property of the file. It must not come back.
    expect(cursor).not.toHaveProperty('encoding');
  });

  it('still LOCATES a tool-internally clipped body, and marks it incomplete (P-005; supersedes the EI-21185758364267344 withholding)', () => {
    const { cursor, next } = doorOversizedPartialJsonResult();

    expect(cursor.kind).toBe('scratch-page');

    // WHERE the body starts and WHETHER it is complete are orthogonal facts.
    // EI-21185758364267344's complaint was the completeness PROMISE, and the
    // remedy taken was to withhold the byte offset entirely. That did not stop
    // anyone parsing these bytes — it pushed them onto "start at the first
    // brace", which in a manifest-bearing spill finds the scratch-reference
    // MANIFEST: a well-formed but WRONG object, i.e. a silent wrong answer
    // instead of a loud failure (EI-21208128396414381, EI-21202588767992062).
    // So the locator is always emitted, and incompleteness is carried by its
    // own field rather than by an ABSENCE no caller can interpret.
    expect(cursor.bodyOffsetInPayload).toEqual(expect.any(Number));
    expect(cursor.bodyComplete).toBe(false);

    // The honesty half must survive intact: the offset must never be read as a
    // promise that paging recovers the omitted records.
    expect(next).toContain('this JSON is partial');
    expect(next).toContain('bodyComplete:false');
    expect(next).toContain('body_truncated');
    expect(next).toContain('paging cannot recover omitted fields');
    expect(next).toContain('Re-call work_items:get');
    expect(next).not.toContain('recover the exact spill bytes');

    // The locator must actually WORK on the partial path, not merely be present.
    const payload = spillBytes();
    const parsed = JSON.parse(payload.subarray(cursor.bodyOffsetInPayload!).toString('utf8')) as {
      ok: boolean;
      results: { section: { body_records_shown: number } }[];
    };
    expect(parsed.ok).toBe(true);
    // ...and what it locates is still the clipped population it warned about.
    expect(parsed.results[0].section.body_records_shown).toBe(11);

    const spill = payload.toString('utf8');
    expect(spill).toContain('D-011');
    expect(spill).not.toContain('D-012');
  });

  it('keeps the JSON recovery pointer no longer than the ambiguous one it replaced', () => {
    // WI-5656's canary sits AT the budget ceiling — a +49-char version of this
    // pointer evicted coord:orient's recovery block from the retained preview.
    // The disambiguation is only affordable because it is paid for elsewhere in
    // the string, so pin that: this is a length CEILING, not a style check.
    const { cursor, next } = doorOversizedResult();
    const AMBIGUOUS_BASELINE =
      'Call capability:read with _projection.cursor.args, base64-decode data, then follow ' +
      'next_cursor until eof to recover the exact spill bytes. The spill begins with a text ' +
      'header and then contains the result as it reached this door.';

    const pointerChars = next.indexOf(' ⓘ') === -1 ? next.length : next.indexOf(' ⓘ');
    expect(pointerChars).toBeLessThanOrEqual(AMBIGUOUS_BASELINE.length);
    expect(JSON.stringify(cursor).length).toBeLessThanOrEqual(
      JSON.stringify({ ...cursor, dataEncoding: undefined, encoding: 'base64' }).length + 8,
    );
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

  it("surfaces capability:read's schema byte-page ceiling in the cursor", () => {
    const { cursor } = doorOversizedResult();

    expect(cursor.maxByteLimit).toBe(4_096);
    expect(cursor.args.byte_limit).toBeLessThanOrEqual(cursor.maxByteLimit!);
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

  it('keeps the referenced payload as plaintext — capability:read unwraps the manifest', () => {
    doorOversizedResult();
    const bytes = spillBytes();
    const text = bytes.toString('utf8');

    expect(text.startsWith('# result-door spill')).toBe(true);
    // Positive proof of plaintext rather than a lenient decode round-trip:
    // the header carries characters that cannot occur in base64 at all.
    expect(text.slice(0, 200)).toMatch(/[#\s]/);
    expect(/^[A-Za-z0-9+/\r\n=]*$/.test(text)).toBe(false);
  });

  it('gives each byte stream its OWN body offset, and each one parses (EI-21239097430071791)', () => {
    const { cursor, next } = doorOversizedResult();

    // The regression this pins: a SINGLE `bodyByteOffset` was measured against
    // the raw on-disk file while the cursor's own `next` sends the caller to
    // capability:read, which strips the ~450-byte manifest header BEFORE
    // applying byte_offset. Following the cursor exactly therefore overshot
    // into the middle of the JSON and produced an unparseable fragment. Each
    // offset is now named for the stream it measures, and both are proved here
    // against that stream — an offset that parses on one and not the other is
    // precisely the defect, so asserting only one would not catch it.
    expect(cursor.bodyOffsetInPayload).toEqual(expect.any(Number));
    expect(cursor.bodyOffsetInFile).toEqual(expect.any(Number));
    expect(next).toContain('skip cursor.bodyOffsetInPayload bytes of response.data for JSON.');

    // A complete body must NOT carry the incompleteness marker.
    expect(cursor.bodyComplete).toBeUndefined();

    const expectWholeBody = (body: string, stream: string): void => {
      let parsed: { ok: boolean; rows: unknown[] };
      try {
        parsed = JSON.parse(body) as { ok: boolean; rows: unknown[] };
      } catch (err) {
        throw new Error(`${stream}: offset did not land on parseable JSON — ${String(err)}`);
      }
      expect(parsed.ok).toBe(true);
      expect(parsed.rows).toHaveLength(400);
    };

    // Stream 1 — capability:read's `response.data`: manifest already stripped.
    expectWholeBody(
      spillBytes().subarray(cursor.bodyOffsetInPayload!).toString('utf8'),
      'response.data',
    );
    // Stream 2 — the raw file at `args.file_path`: manifest header included.
    expectWholeBody(
      spillRawBytes().subarray(cursor.bodyOffsetInFile!).toString('utf8'),
      'raw file',
    );

    // The two streams differ by exactly the manifest header — the quantity that
    // was silently conflated. Pinning the RELATION keeps the two offsets from
    // drifting back into one.
    expect(cursor.bodyOffsetInFile!).toBeGreaterThan(cursor.bodyOffsetInPayload!);
    expect(cursor.bodyOffsetInFile! - cursor.bodyOffsetInPayload!).toBe(
      spillRawBytes().length - spillBytes().length,
    );

    // The first `{` in the raw file is the MANIFEST, not the body: the reason a
    // "start at the first brace" fallback returns a well-formed WRONG object.
    expect(spillRawBytes().indexOf('{')).toBeLessThan(cursor.bodyOffsetInFile!);

    // CONTROLS — a permanently-wrong implementation kept beside the real one, so
    // this test is demonstrably falsifiable rather than merely passing. Both
    // reproduce the exact original defect; if either ever starts succeeding, the
    // two offsets have collapsed back into one and the assertions above have
    // stopped discriminating.
    //
    // Control 1: the OLD behaviour — the file-relative offset applied to
    // capability:read's payload, which is what the cursor's `next` sends you to.
    expect(() =>
      JSON.parse(spillBytes().subarray(cursor.bodyOffsetInFile!).toString('utf8')),
    ).toThrow();
    // Control 2: the fallback the missing offset forced — "start at the first
    // brace" in the raw file parses, but yields the MANIFEST, not the result.
    const firstBrace = JSON.parse(
      spillRawBytes().subarray(spillRawBytes().indexOf('{')).toString('utf8').split('\n')[0],
    ) as Record<string, unknown>;
    expect(firstBrace).toHaveProperty('schemaVersion');
    expect(firstBrace).not.toHaveProperty('rows');
  });

  it('follows the emitted cursor end-to-end through the real capability:read', async () => {
    const { cursor } = doorOversizedResult();
    expect(cursor.tool).toBe('capability:read');

    // Execute the instruction exactly as an agent would: the cursor's own args,
    // through the actual tool handler — no re-implementation of the byte window.
    const res = (await readTool.handler(cursor.args as never, {
      projectDir: sandbox,
      workspaceId: WS,
    } as never)) as {
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
    expect(page.encoding).toBe(cursor.dataEncoding);
    expect(page.encoding).toBe('base64');

    const decoded = Buffer.from(page.data, 'base64');
    expect(decoded.equals(spillBytes().subarray(0, page.byte_length))).toBe(true);
    expect(decoded.toString('utf8').startsWith('# result-door spill')).toBe(true);
  });
});
