/**
 * read-byte-page-door-fit.test.ts — WI-39670.
 *
 * `capability:read`'s byte window is the documented recovery path for a spilled
 * tool result: page the spill, base64-decode `data`, follow `next_cursor`. Every
 * tool result also passes the `resultEach` door, and an over-budget result is
 * projected — which for this tool truncates `data` MID-BASE64. The decode then
 * yields a valid plaintext prefix followed by `invalid input`: silent corruption
 * of the path an agent runs precisely when it has already lost state, while
 * `ok:true`, `eof:false` and a well-formed `next_cursor` all still look healthy.
 *
 * A 4096-byte page is 5464 chars of base64 on its own — over the 6000-char door
 * before the envelope is even counted — so the maximum page the schema ADVERTISED
 * could never be returned intact (EI-20545077286837456, EI-20501871898754755;
 * both were watchdog-auto-closed while the defect stayed live).
 *
 * So these tests assert the property that matters — a page that survives the door
 * and decodes cleanly — rather than any particular page size, and they exercise
 * the real door rather than re-deriving its arithmetic.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS } from '../../context-doors';

const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('../../context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import { applyResultDoor } from '../../result-door';
import type { DoorableResult } from '../../result-door';
import readTool, { MAX_BYTE_PAGE, doorSafePageBytes } from './read';

let sandbox: string;
let filePath: string;
let prevScratchRoot: string | undefined;

/** Distinctive, non-repeating bytes so a truncated decode cannot accidentally match. */
function payload(bytes: number): Buffer {
  let s = '';
  for (let i = 0; s.length < bytes; i++) s += `chunk-${i}-${'abcdefghij'[i % 10]}-payload|`;
  return Buffer.from(s.slice(0, bytes), 'utf8');
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-byte-page-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
  // A deep path is part of the subject: `file_path` is absolute and appears
  // TWICE in the response, so path length is what moves the real ceiling.
  filePath = join(sandbox, 'scratch', 'papercusp-workspace', 'work_items:get', 'a'.repeat(36), 'result-door-1786953789399.md');
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, payload(40_000));
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  rmSync(sandbox, { recursive: true, force: true });
});

/** Run the tool, then push its result through the REAL door the way the transport does. */
async function readThroughDoor(args: Record<string, unknown>) {
  const res = (await readTool.handler(args as never, { projectDir: sandbox } as never)) as {
    content: Array<{ type: string; text: string }>;
  };
  const doored = applyResultDoor(
    { content: res.content as Array<{ type: 'text'; text: string }> },
    { toolName: 'capability:read', workspaceId: 'ws-1', runId: '99999999-8888-4777-8666-555555555555' },
  ) as DoorableResult;
  const text = (doored.content.find((c) => (c as { type?: string }).type === 'text') as { text: string }).text;
  return { text, parsed: JSON.parse(text) as Record<string, unknown> };
}

describe('WI-39670: byte-window pages survive the result door intact', () => {
  it('returns base64 that decodes cleanly at the ADVERTISED max byte_limit', async () => {
    const { parsed } = await readThroughDoor({ file_path: filePath, byte_offset: 0, byte_limit: MAX_BYTE_PAGE });

    // The door must not have projected the payload — this is the whole defect.
    expect(parsed).not.toHaveProperty('_projection');
    expect(parsed.ok).toBe(true);

    const data = parsed.data as string;
    expect(data).not.toContain('TRUNCATED');
    // A truncated base64 string decodes to a prefix; a whole one round-trips.
    const decoded = Buffer.from(data, 'base64');
    expect(decoded.length).toBe(parsed.byte_length);
    expect(decoded.toString('base64')).toBe(data);
    expect(decoded.equals(payload(40_000).subarray(0, decoded.length))).toBe(true);
  });

  it('reports the page it actually returned, and advances by exactly that', async () => {
    const { parsed } = await readThroughDoor({ file_path: filePath, byte_offset: 0, byte_limit: MAX_BYTE_PAGE });

    const byteLength = parsed.byte_length as number;
    expect(byteLength).toBeGreaterThan(0);
    expect(byteLength).toBeLessThanOrEqual(MAX_BYTE_PAGE);
    // Clamping is only lossless if the cursor advances by the REAL page size.
    const cursor = parsed.next_cursor as { args: { byte_offset: number; byte_limit: number } };
    expect(cursor.args.byte_offset).toBe(byteLength);
    // ...and only stable if it stops asking for a size that will be clamped again.
    expect(cursor.args.byte_limit).toBe(byteLength);
  });

  it('pages a file to eof losslessly by following its own cursors', async () => {
    const original = payload(40_000);
    const chunks: Buffer[] = [];
    let args: Record<string, unknown> = { file_path: filePath, byte_offset: 0, byte_limit: MAX_BYTE_PAGE };

    for (let hop = 0; hop < 200; hop++) {
      const { parsed } = await readThroughDoor(args);
      expect(parsed).not.toHaveProperty('_projection');
      chunks.push(Buffer.from(parsed.data as string, 'base64'));
      const next = parsed.next_cursor as { args: Record<string, unknown> } | null;
      if (next === null) {
        expect(parsed.eof).toBe(true);
        break;
      }
      args = next.args;
    }

    // Reassembly is the real acceptance test: any truncated hop corrupts this.
    expect(Buffer.concat(chunks).equals(original)).toBe(true);
  });

  it('shrinks the page as the path grows, since the path is in the envelope twice', () => {
    const shortPath = '/tmp/s.md';
    const longPath = `/tmp/${'deep-scratch-segment/'.repeat(12)}result-door-1786953789399.md`;

    expect(doorSafePageBytes(longPath, MAX_BYTE_PAGE)).toBeLessThan(
      doorSafePageBytes(shortPath, MAX_BYTE_PAGE),
    );
    // A caller asking for less than the ceiling is never inflated to it.
    expect(doorSafePageBytes(shortPath, 1_024)).toBe(1_024);
  });
});
