/**
 * PaperBench paper-replication driver — core tests (plan benchmark-suite-paperbench-2026-06-17, #18).
 * Pure: a FAKE `drive` op + a real temp dir — NO arm / NO LLM / NO docker. Proves arg parsing, paper
 * reading, tree validation, and the never-throw drive→validate contract the Python solver depends on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePbArgs,
  readPaperContext,
  countTreeFiles,
  hasReproduceSh,
  drivePaperReplication,
  type PaperReplicationOps,
  type PaperReplicationRequest,
} from './_pb_hive_solve';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function req(over: Partial<PaperReplicationRequest> = {}): PaperReplicationRequest {
  return {
    paperId: 'rice',
    paperContext: { paperId: 'rice', paperDir: dir, instructions: '', paperMd: '', addendum: '', blacklist: '', pdfPath: null },
    outDir: join(dir, 'submission'),
    arm: 'hive',
    budgetUsd: 40,
    codeOnly: true,
    runId: 'pb-rice',
    workspaceId: 'papercusp-workspace',
    ...over,
  };
}

/** A fake arm op that writes `files` (relative path → content) into outDir, simulating a produced tree. */
function fakeDrive(files: Record<string, string>, telem = { costUsd: 3.2, agentId: 's-bee-1' }): PaperReplicationOps {
  return {
    async drive(r) {
      for (const [rel, content] of Object.entries(files)) {
        const p = join(r.outDir, rel);
        mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true });
        writeFileSync(p, content);
      }
      return { filesWritten: Object.keys(files).length, costUsd: telem.costUsd, agentId: telem.agentId };
    },
  };
}

describe('parsePbArgs', () => {
  it('parses the solver CLI with defaults', () => {
    const a = parsePbArgs(['--paper-id', 'rice', '--paper-dir', '/p', '--out', '/o', '--code-only']);
    expect(a).toEqual({ paperId: 'rice', paperDir: '/p', out: '/o', arm: 'hive', budgetUsd: 40, codeOnly: true });
  });
  it('honors --arm and --budget-usd; --code-only absent → false', () => {
    const a = parsePbArgs(['--paper-id', 'x', '--paper-dir', '/p', '--out', '/o', '--arm', 'su-independent', '--budget-usd', '99']);
    expect(a.arm).toBe('su-independent');
    expect(a.budgetUsd).toBe(99);
    expect(a.codeOnly).toBe(false);
  });
  it('throws when a required flag is missing', () => {
    expect(() => parsePbArgs(['--paper-id', 'x', '--paper-dir', '/p'])).toThrow(/usage:/);
  });
});

describe('readPaperContext', () => {
  it('reads present files and leaves missing ones empty; sets pdfPath only when present', () => {
    writeFileSync(join(dir, 'paper.md'), '# Paper');
    writeFileSync(join(dir, 'instructions.txt'), 'do it');
    const ctx = readPaperContext('rice', dir);
    expect(ctx.paperMd).toBe('# Paper');
    expect(ctx.instructions).toBe('do it');
    expect(ctx.addendum).toBe(''); // missing → ''
    expect(ctx.pdfPath).toBeNull();
    writeFileSync(join(dir, 'paper.pdf'), 'PDFBYTES');
    expect(readPaperContext('rice', dir).pdfPath).toBe(join(dir, 'paper.pdf'));
  });
});

describe('countTreeFiles + hasReproduceSh', () => {
  it('counts nested files and detects a root reproduce.sh', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'reproduce.sh'), '#!/bin/bash');
    writeFileSync(join(dir, 'src', 'train.py'), 'print(1)');
    expect(countTreeFiles(dir)).toBe(2);
    expect(hasReproduceSh(dir)).toBe(true);
    expect(countTreeFiles(join(dir, 'nope'))).toBe(0);
  });
});

describe('drivePaperReplication', () => {
  it('ok when the arm produces a non-empty tree with reproduce.sh; counts from disk', async () => {
    const res = await drivePaperReplication(req(), fakeDrive({ 'reproduce.sh': '#!/bin/bash', 'src/model.py': 'x=1' }));
    expect(res.ok).toBe(true);
    expect(res.filesWritten).toBe(2);
    expect(res.hasReproduceSh).toBe(true);
    expect(res.costUsd).toBe(3.2);
    expect(res.agentId).toBe('s-bee-1');
    expect(res.error).toBeUndefined();
  });

  it('not ok + error on an empty submission', async () => {
    const res = await drivePaperReplication(req(), fakeDrive({}));
    expect(res.ok).toBe(false);
    expect(res.filesWritten).toBe(0);
    expect(res.error).toMatch(/empty submission/);
  });

  it('still ok (files>0) but loudly flags a missing reproduce.sh in code-only mode', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await drivePaperReplication(req({ codeOnly: true }), fakeDrive({ 'src/model.py': 'x=1' }));
    expect(res.ok).toBe(true);
    expect(res.hasReproduceSh).toBe(false);
    expect(res.error).toBeUndefined(); // non-fatal — grade reflects reality
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no root reproduce\.sh/));
    warn.mockRestore();
  });

  it('never throws when the arm op throws — returns an error result', async () => {
    const throwing: PaperReplicationOps = {
      async drive() {
        throw new Error('bee infra-failed at $0');
      },
    };
    const res = await drivePaperReplication(req(), throwing);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/arm drive failed.*infra-failed/);
  });
});
