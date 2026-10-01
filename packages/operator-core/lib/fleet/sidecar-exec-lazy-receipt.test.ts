/**
 * WI-10004674 / WI-10003465 — a read-only git exec lives ~4 ms but its durable
 * resource-governor receipt costs four awaited PG statements, so the sidecar's
 * 2-connection pool queued every git read behind bookkeeping (measured p50
 * 0.5-3.5 s per read vs 5 ms for bare git, ~59% of native-PG WAL).
 *
 * `execProcess` now spawns a QUALIFYING (read-only git) command first and mints
 * the receipt only if the command outlives `lazyReceiptMs`. These tests pin both
 * directions: the fast read never touches the governor, the slow read still gets
 * a full receipt, and every command that does NOT qualify is still admitted
 * BEFORE the child exists.
 *
 * Real child processes: a fake `git` on the child's PATH gives a deterministic
 * duration and lets the test read back the env the child was handed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AdmissionContext } from '../resource-governor/admission';
import type { GovernedExecution } from '../resource-governor/execution';
import {
  execProcess,
  gitSubcommandOf,
  qualifiesForLazyReceipt,
  SIDECAR_LAZY_RECEIPT_DELAY_MS,
  type ExecParams,
} from './sidecar-exec-process';

function context(id: string): AdmissionContext {
  return {
    contractVersion: 1,
    requestId: id,
    rootRequestId: id,
    parentRequestId: null,
    idempotencyKey: id,
    admissionClass: 'process',
    priority: 0,
    demand: { cpuWeight: 1 },
    depth: 0,
    createdAtMs: 1,
    decisionGeneration: 1,
  };
}

function receiptSpies(overrides: { finish?: () => Promise<boolean> } = {}) {
  const finish = vi.fn(overrides.finish ?? (async () => true));
  const cancel = vi.fn(async () => true);
  const execution: GovernedExecution = {
    receiptId: 'lazy-test',
    context: context('minted-receipt'),
    lease: { leaseId: 'l', generation: 1, admissionClass: 'process', expiresAtMs: 2, owner: 'test' },
    finish,
    cancel,
  };
  return { finish, cancel, execution };
}

describe('gitSubcommandOf / qualifiesForLazyReceipt (pure)', () => {
  it.each([
    [['rev-parse', 'HEAD'], 'rev-parse'],
    [['-C', '/some/dir', 'log', '-1'], 'log'],
    [['-c', 'core.quotepath=off', 'ls-remote', 'origin'], 'ls-remote'],
    [['--no-pager', '--git-dir=/x/.git', 'cat-file', '--batch'], 'cat-file'],
    [['--git-dir', '/x/.git', '--work-tree', '/x', 'diff-tree'], 'diff-tree'],
    [['--weird-global', 'log'], null], // an option the parser does not know could swallow a token
    [[], null],
    [['-C'], null],
  ] as const)('gitSubcommandOf(%j) = %j', (args, expected) => {
    expect(gitSubcommandOf(args)).toBe(expected);
  });

  it.each([
    ['git', ['rev-parse', '--verify', 'HEAD'], true],
    ['/usr/bin/git', ['-C', '/r', 'cat-file', '--batch-check'], true],
    ['git', ['ls-remote', 'origin', 'refs/heads/main'], true],
    // writers / hook-capable commands stay eager: they deserve a receipt before the child exists
    ['git', ['commit', '-m', 'x'], false],
    ['git', ['push', 'origin', 'staging'], false],
    ['git', ['fetch', 'origin'], false],
    ['git', ['checkout', 'main'], false],
    ['git', ['merge', 'x'], false],
    ['git', ['status', '--porcelain'], false], // fsmonitor can run a hook
    ['git', ['definitely-an-alias'], false],
    ['node', ['rev-parse'], false],
    ['gitk', ['rev-parse'], false],
    ['git', [], false],
  ] as const)('qualifiesForLazyReceipt(%s %j) = %s', (command, args, expected) => {
    expect(qualifiesForLazyReceipt({ command, args: [...args] })).toBe(expected);
  });

  it('exposes a delay long enough that a ~4 ms read never mints but a network ls-remote does', () => {
    expect(SIDECAR_LAZY_RECEIPT_DELAY_MS).toBeGreaterThanOrEqual(250);
    expect(SIDECAR_LAZY_RECEIPT_DELAY_MS).toBeLessThanOrEqual(2_000);
  });
});

describe('execProcess lazy receipt (real child processes)', () => {
  let bin: string;
  let marker: string;

  beforeAll(async () => {
    bin = await mkdtemp(join(tmpdir(), 'lazy-receipt-'));
    marker = join(bin, 'child-started');
    // Fake `git`: records that the child started, optionally sleeps, then echoes
    // its argv and the admission context it was handed.
    await writeFile(
      join(bin, 'git'),
      [
        '#!/bin/sh',
        `touch "${marker}"`,
        'sleep "${FAKE_GIT_SLEEP:-0}"',
        'echo "ctx=${PAPERCUSP_ADMISSION_CONTEXT-<unset>}"',
        'echo "args=$*"',
        'exit "${FAKE_GIT_EXIT:-0}"',
      ].join('\n'),
    );
    await chmod(join(bin, 'git'), 0o755);
  });

  afterAll(async () => {
    await rm(bin, { recursive: true, force: true });
  });

  const run = (
    args: string[],
    env: Record<string, string> = {},
    extra: Partial<ExecParams> = {},
  ): ExecParams => ({
    command: 'git',
    args,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
    timeoutMs: 20_000,
    ...extra,
  });

  it('a fast read-only git exec never touches the governor (no admit, no lease, no settle)', async () => {
    const { execution, finish, cancel } = receiptSpies();
    const begin = vi.fn(async () => execution);
    const result = await execProcess(run(['rev-parse', 'HEAD']), { beginExecution: begin, lazyReceiptMs: 5_000 });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('args=rev-parse HEAD');
    expect(begin).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a read that outlives the delay still gets exactly one receipt, minted late and settled on exit', async () => {
    const { execution, finish, cancel } = receiptSpies();
    const begin = vi.fn(async () => execution);
    const result = await execProcess(run(['ls-remote', 'origin'], { FAKE_GIT_SLEEP: '0.6' }), {
      beginExecution: begin,
      lazyReceiptMs: 100,
    });

    expect(result.code).toBe(0);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({ cpuWeight: 1 });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('the late receipt is minted AFTER the child started (the delay measures runtime, not setup)', async () => {
    const { execution } = receiptSpies();
    await rm(marker, { force: true });
    let childStartedAtBegin: boolean | null = null;
    const begin = vi.fn(async () => {
      childStartedAtBegin = existsSync(marker);
      return execution;
    });
    await execProcess(run(['ls-remote', 'origin'], { FAKE_GIT_SLEEP: '0.5' }), { beginExecution: begin, lazyReceiptMs: 100 });
    expect(childStartedAtBegin).toBe(true);
  });

  it('a NON-qualifying command is still admitted BEFORE the child exists, whatever lazyReceiptMs says', async () => {
    const { execution, finish } = receiptSpies();
    await rm(marker, { force: true });
    let childStartedAtBegin: boolean | null = null;
    const begin = vi.fn(async () => {
      childStartedAtBegin = existsSync(marker);
      return execution;
    });
    const result = await execProcess(run(['commit', '-m', 'x']), { beginExecution: begin, lazyReceiptMs: 5_000 });

    expect(result.code).toBe(0);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(childStartedAtBegin).toBe(false);
    expect(finish).toHaveBeenCalledTimes(1);
    // the child inherits the receipt's own nested-lineage context
    expect(result.stdout).toContain(`ctx=${JSON.stringify(execution.context)}`);
  });

  it('lazyReceiptMs:0 restores eager admission even for a qualifying read', async () => {
    const { execution, finish } = receiptSpies();
    const begin = vi.fn(async () => execution);
    await execProcess(run(['rev-parse', 'HEAD']), { beginExecution: begin, lazyReceiptMs: 0 });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('a lazy read hands the child the caller-supplied PARENT lineage (it has no receipt of its own yet)', async () => {
    const parent = context('caller-parent');
    const begin = vi.fn(async () => receiptSpies().execution);
    const result = await execProcess(run(['rev-parse', 'HEAD'], {}, { admissionContext: parent }), {
      beginExecution: begin,
      lazyReceiptMs: 5_000,
    });
    expect(result.stdout).toContain(`ctx=${JSON.stringify(parent)}`);
    expect(begin).not.toHaveBeenCalled();
  });

  it('a late receipt that fails to mint never fails the read it was documenting', async () => {
    const begin = vi.fn(async () => {
      throw new Error('pg pool exhausted');
    });
    const result = await execProcess(run(['ls-remote', 'origin'], { FAKE_GIT_SLEEP: '0.4' }), {
      beginExecution: begin,
      lazyReceiptMs: 100,
    });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('admission');
  });

  it('a late receipt whose settlement fails never turns a successful read into an error', async () => {
    const { execution, finish } = receiptSpies({
      finish: async () => {
        throw new Error('release UPDATE timed out');
      },
    });
    const result = await execProcess(run(['ls-remote', 'origin'], { FAKE_GIT_SLEEP: '0.4' }), {
      beginExecution: async () => execution,
      lazyReceiptMs: 100,
    });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('settlement failed');
  });

  it('the exit code of a failing lazy read is preserved', async () => {
    const result = await execProcess(run(['rev-parse', 'nope'], { FAKE_GIT_EXIT: '128' }), {
      beginExecution: async () => receiptSpies().execution,
      lazyReceiptMs: 5_000,
    });
    expect(result.code).toBe(128);
  });

  it('EAGER settlement failures still surface exactly as before (the unchanged contract)', async () => {
    const { execution } = receiptSpies({
      finish: async () => {
        throw new Error('release UPDATE timed out');
      },
    });
    const result = await execProcess(run(['commit', '-m', 'x']), { beginExecution: async () => execution, lazyReceiptMs: 5_000 });
    expect(result.code).toBe(-1);
    expect(result.stderr).toContain('sidecar process admission settlement failed');
  });

  it('an already-aborted caller starts nothing and mints nothing', async () => {
    const begin = vi.fn(async () => receiptSpies().execution);
    await rm(marker, { force: true });
    const ac = new AbortController();
    ac.abort();
    const result = await execProcess(run(['rev-parse', 'HEAD']), { beginExecution: begin, lazyReceiptMs: 5_000, signal: ac.signal });
    expect(result.code).toBe(-1);
    expect(begin).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });
});
