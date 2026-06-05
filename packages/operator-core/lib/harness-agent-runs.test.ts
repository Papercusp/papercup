/**
 * Coverage for harness-agent-runs.probeRunLiveness — decides whether an agent
 * run is still live from its run.jsonl: missing → not running, a tail
 * "type":"result" line → finished, otherwise running iff the mtime is within the
 * 10-min grace of `now`. Real temp files; `now` derived from the file's mtime.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeRunLiveness } from './harness-agent-runs';

const GRACE = 10 * 60_000;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-runs-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeJsonl(name: string, content: string): { path: string; mtime: number } {
  const path = join(dir, name);
  writeFileSync(path, content);
  return { path, mtime: statSync(path).mtimeMs };
}

describe('probeRunLiveness', () => {
  it('reports not-running for a missing file', () => {
    expect(probeRunLiveness(join(dir, 'nope.jsonl'), Date.now())).toEqual({
      running: false,
      lastEventTs: 0,
    });
  });

  it('reports finished when the tail contains a result event', () => {
    const { path, mtime } = writeJsonl('done.jsonl', '{"type":"system"}\n{"type":"result","x":1}\n');
    // Even within the grace window, a result line means finished.
    expect(probeRunLiveness(path, mtime + 1000)).toEqual({ running: false, lastEventTs: mtime });
  });

  it('reports running when there is no result and the mtime is within grace', () => {
    const { path, mtime } = writeJsonl('live.jsonl', '{"type":"assistant"}\n');
    expect(probeRunLiveness(path, mtime + 1000).running).toBe(true);
  });

  it('reports not-running when no result and the mtime is past grace (stale)', () => {
    const { path, mtime } = writeJsonl('stale.jsonl', '{"type":"assistant"}\n');
    expect(probeRunLiveness(path, mtime + GRACE + 1).running).toBe(false);
  });

  it('handles an empty file via the mtime grace', () => {
    const { path, mtime } = writeJsonl('empty.jsonl', '');
    expect(probeRunLiveness(path, mtime + 1000).running).toBe(true);
    expect(probeRunLiveness(path, mtime + GRACE + 1).running).toBe(false);
  });
});
