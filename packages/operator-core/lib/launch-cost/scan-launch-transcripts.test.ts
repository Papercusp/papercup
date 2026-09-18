import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectTranscriptFiles,
  measureTranscriptFile,
  ownerIdFromPath,
  scanLaunchTranscripts,
} from './scan-launch-transcripts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'launch-cost-scan-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Build `<root>/<owner>/projects/<project>/<session>.jsonl` and return its path. */
async function writeTranscript(
  owner: string,
  session: string,
  lines: unknown[],
  project = '-repo',
): Promise<string> {
  const dir = join(root, owner, 'projects', project);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${session}.jsonl`);
  await writeFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return filePath;
}

function usageEntry(overrides: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-09-18T06:31:53.858Z',
    entrypoint: 'cli',
    version: '2.1.0',
    cwd: '/repo',
    sessionId: 'session-a',
    message: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 128_745,
        cache_read_input_tokens: 103_666,
        output_tokens: 296,
      },
    },
    ...overrides,
  };
}

describe('measureTranscriptFile — the streaming guarantee', () => {
  it('finds a usage row that sits far past any bounded read window', async () => {
    // ⚠ THE LOAD-BEARING TEST OF THIS FILE.
    // A real psu transcript opens with a ~580 KB system-prompt entry on ONE line. Any reader
    // that inspects a bounded prefix (a 600 KB read window, `head -c`, a capped file-read tool)
    // never reaches the usage row and reports ZERO ROWS — which is indistinguishable from "this
    // session has no data" and is exactly how this corpus reads as empty. This fixture puts a
    // ~700 KB first line ahead of the usage row, so a non-streaming implementation fails here.
    const hugeSystemPrompt = {
      type: 'system',
      timestamp: '2026-09-18T06:31:00.000Z',
      content: 'x'.repeat(700_000),
    };
    const filePath = await writeTranscript('su-a', 'session-a', [hugeSystemPrompt, usageEntry()]);

    const outcome = await measureTranscriptFile(filePath, { root });

    expect(outcome).toHaveProperty('sample');
    const { sample } = outcome as { sample: { totalPromptTokens: number; bytesBeforeSample: number } };
    expect(sample.totalPromptTokens).toBe(232_413);
    // Positive control for the claim above: the sample really did sit past a 600 KB window, so
    // a passing assertion here cannot be explained by the fixture having been small all along.
    expect(sample.bytesBeforeSample).toBeGreaterThan(600_000);
  });

  it('reports the full sample shape from the first qualifying row', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'user', timestamp: '2026-09-18T06:30:00.000Z' },
      usageEntry(),
      usageEntry({ timestamp: '2026-09-18T07:00:00.000Z' }),
    ]);

    const outcome = await measureTranscriptFile(filePath, { root });
    const { sample } = outcome as { sample: Record<string, unknown> };

    expect(sample).toMatchObject({
      ownerId: 'su-a',
      sessionId: 'session-a',
      day: '2026-09-18',
      model: 'claude-opus-5',
      entrypoint: 'cli',
      cliVersion: '2.1.0',
      inputTokens: 2,
      cacheCreationTokens: 128_745,
      cacheReadTokens: 103_666,
      totalPromptTokens: 232_413,
      // The FIRST usage row, not the last: line 2 of the file.
      lineNumber: 2,
    });
  });

  it('skips past small usage rows to the real launch turn', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'assistant', timestamp: '2026-09-18T06:29:00.000Z', message: { usage: { input_tokens: 40 } } },
      usageEntry(),
    ]);
    const outcome = await measureTranscriptFile(filePath, { root });
    expect((outcome as { sample: { totalPromptTokens: number } }).sample.totalPromptTokens).toBe(
      232_413,
    );
  });

  it('tolerates blank and malformed lines without aborting the scan', async () => {
    const dir = join(root, 'su-a', 'projects', '-repo');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, 'session-a.jsonl');
    await writeFile(filePath, `\n{not json\n\n${JSON.stringify(usageEntry())}\n`, 'utf8');

    const outcome = await measureTranscriptFile(filePath, { root });
    expect(outcome).toHaveProperty('sample');
  });
});

describe('measureTranscriptFile — typed skips, never silent drops', () => {
  it('reports no-usage-row for a transcript with no usage at all', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'user', timestamp: '2026-09-18T06:30:00.000Z' },
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({
      skip: { filePath, reason: 'no-usage-row' },
    });
  });

  it('reports all-below-threshold when every usage row is under the floor', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      { type: 'assistant', timestamp: '2026-09-18T06:30:00.000Z', message: { usage: { input_tokens: 40 } } },
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({
      skip: { filePath, reason: 'all-below-threshold' },
    });
  });

  it('reports sidechain-only when the only large turns are sub-agent turns', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      usageEntry({ isSidechain: true }),
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toEqual({
      skip: { filePath, reason: 'sidechain-only' },
    });
    // ...and measures it when sidechains are explicitly requested.
    const included = await measureTranscriptFile(filePath, { root, includeSidechains: true });
    expect(included).toHaveProperty('sample');
  });

  it('reports undatable rather than inventing a day', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [
      usageEntry({ timestamp: 'whenever' }),
    ]);
    expect(await measureTranscriptFile(filePath, { root })).toMatchObject({
      skip: { reason: 'undatable' },
    });
  });

  it('reports unreadable for a file that does not exist', async () => {
    const filePath = join(root, 'su-a', 'projects', '-repo', 'missing.jsonl');
    expect(await measureTranscriptFile(filePath, { root })).toMatchObject({
      skip: { reason: 'unreadable' },
    });
  });

  it('applies day, model and owner filters as filtered-out skips', async () => {
    const filePath = await writeTranscript('su-a', 'session-a', [usageEntry()]);
    expect(await measureTranscriptFile(filePath, { root, since: '2026-09-19' })).toMatchObject({
      skip: { reason: 'filtered-out' },
    });
    expect(await measureTranscriptFile(filePath, { root, until: '2026-09-17' })).toMatchObject({
      skip: { reason: 'filtered-out' },
    });
    expect(
      await measureTranscriptFile(filePath, { root, modelContains: 'sonnet' }),
    ).toMatchObject({ skip: { reason: 'filtered-out' } });
    expect(await measureTranscriptFile(filePath, { root, ownerPrefix: 'role-' })).toMatchObject({
      skip: { reason: 'filtered-out' },
    });
    // Inclusive bounds on both ends.
    expect(
      await measureTranscriptFile(filePath, { root, since: '2026-09-18', until: '2026-09-18' }),
    ).toHaveProperty('sample');
  });
});

describe('collectTranscriptFiles', () => {
  it('finds transcripts nested under owner/projects/<project>', async () => {
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    await writeTranscript('role-b', 'session-b', [usageEntry()], '-other');
    await writeFile(join(root, 'not-a-transcript.txt'), 'ignored', 'utf8');

    const files = await collectTranscriptFiles(root);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.jsonl'))).toBe(true);
  });

  it('does not follow directory symlinks', async () => {
    // The repo guide's `find -L` incident: a symlink DAG under this tree ran 32h and consumed
    // 1.86 TB of swap. A transcript tree has no legitimate need to traverse a link, so a link
    // that would double the corpus must contribute nothing.
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    await symlink(join(root, 'su-a'), join(root, 'su-a-link'), 'dir');

    const files = await collectTranscriptFiles(root);
    expect(files).toHaveLength(1);
  });

  it('respects maxDepth', async () => {
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    // owner(1)/projects(2)/-repo(3)/file — depth 2 stops before the file's directory.
    expect(await collectTranscriptFiles(root, 2)).toHaveLength(0);
    expect(await collectTranscriptFiles(root, 3)).toHaveLength(1);
  });

  it('returns an empty list for a root that does not exist', async () => {
    expect(await collectTranscriptFiles(join(root, 'nope'))).toEqual([]);
  });
});

describe('ownerIdFromPath', () => {
  it('reads the first path segment below the root', () => {
    expect(ownerIdFromPath('/r', '/r/su-abc/projects/-repo/s.jsonl')).toBe('su-abc');
  });

  it('returns unknown for a path outside the root', () => {
    expect(ownerIdFromPath('/r', '/elsewhere/s.jsonl')).toBe('unknown');
  });
});

describe('scanLaunchTranscripts', () => {
  it('measures every transcript and censuses each skip by reason', async () => {
    await writeTranscript('su-a', 'session-a', [usageEntry()]);
    await writeTranscript('su-b', 'session-b', [
      usageEntry({ sessionId: 'session-b', timestamp: '2026-09-11T10:00:00.000Z' }),
    ]);
    await writeTranscript('su-c', 'session-c', [{ type: 'user' }]);
    await writeTranscript('su-d', 'session-d', [usageEntry({ isSidechain: true })]);

    const report = await scanLaunchTranscripts({ root });

    expect(report.filesScanned).toBe(4);
    expect(report.filesMeasured).toBe(2);
    expect(report.skippedByReason['no-usage-row']).toBe(1);
    expect(report.skippedByReason['sidechain-only']).toBe(1);
    expect(report.skipped).toHaveLength(2);
    // filesScanned === filesMeasured + skipped.length: no file is silently dropped.
    expect(report.filesMeasured + report.skipped.length).toBe(report.filesScanned);
    // Samples are ordered oldest-first by measured timestamp.
    expect(report.samples.map((s) => s.day)).toEqual(['2026-09-11', '2026-09-18']);
  });

  it('returns an honest empty report for an empty tree rather than failing', async () => {
    const report = await scanLaunchTranscripts({ root });
    expect(report.filesScanned).toBe(0);
    expect(report.samples).toEqual([]);
    expect(report.skipped).toEqual([]);
  });
});
