/**
 * Lock-key derivation — the payload OMP's coord-hook actually sends to
 * `locks:acquire`.
 *
 * Plan: omp-context-injection-and-behavior-2026-08-12, P-003.
 *
 * MEASURED FAILURE (harness_shared.tool_invocations, 2026-08-11): one OMP
 * session emitted 220 `locks:acquire` calls — ALL byte-identical, ALL with
 * `paths: []`, ALL rejected `invalid_args`. File-lock enforcement was
 * therefore OFF for every edit that session made, for six hours.
 *
 * Root cause was a single expression in onToolCall's inlined dedupe:
 *
 *     .filter((x) => !(seen.has(x) || seen.add(x)))
 *
 * `Set.add()` returns the SET, not a boolean — so `false || Set` is truthy
 * and the negation is `false` for EVERY element. The list was
 * unconditionally emptied; this never "sometimes" worked.
 *
 * Why no test caught it: a guard test DID exist and DID pass throughout —
 * it asserted on `extractPathsFromToolInput`, a sibling projection that
 * `onToolCall` did not use. So this suite pins the SEAM (a single shared
 * derivation) as well as the values. Asserting only that the output is
 * correct would leave the divergence that hid the bug fully intact.
 *
 * Second defect covered here: the rejection was invisible. `callMcpTool`
 * collapses a refusal to `null` unless `preserveErrors` is set, so a
 * deterministic schema failure took the "operator unreachable" fail-open
 * branch and was recorded as a transient transport miss — 220 times,
 * escalating nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  onToolCall,
  extractLockTargets,
  extractPathsFromToolInput,
  lockKeysFromTargets,
  asStructuredCallError,
  _resetRequestDefectCountForTests,
  _resetToolCallCacheForTests,
} from '../coord-hook';

/**
 * A workspace with one `.git` worktree named `papercusp` — the hook keys
 * locks by walking up to `.git`, gated on the worktree being a direct
 * child of PAPERCUSP_WORKSPACE_ROOT, and its worktree guard refuses any
 * tree that is not the canonical staging checkout.
 */
async function makeWorktreeFixture(): Promise<{
  workspace: string;
  repo: string;
  cleanup: () => Promise<void>;
}> {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'omp-lockkey-ws-')));
  const repo = join(base, 'papercusp');
  await fs.mkdir(join(repo, '.git'), { recursive: true });
  return {
    workspace: base,
    repo,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

describe('lockKeysFromTargets — the acquire payload', () => {
  it('NEVER returns an empty list for a non-empty target list (the 220-failure regression)', () => {
    expect(lockKeysFromTargets([{ root: '/r', rel: 'a.ts' }])).toEqual(['a.ts']);
    expect(
      lockKeysFromTargets([
        { root: '/r', rel: 'a.ts' },
        { root: '/r', rel: 'b.ts' },
      ]),
    ).toEqual(['a.ts', 'b.ts']);
  });

  it('still dedupes, keeping first-seen order (what the broken idiom was reaching for)', () => {
    expect(
      lockKeysFromTargets([
        { root: '/r', rel: 'b.ts' },
        { root: '/other', rel: 'b.ts' },
        { root: '/r', rel: 'a.ts' },
        { root: '/r', rel: 'b.ts' },
      ]),
    ).toEqual(['b.ts', 'a.ts']);
  });

  it('CONTROL: the shipped predicate empties every list — so the assertions above can fail', () => {
    // The exact expression that was live in onToolCall. If this control
    // ever stops emptying, the assertions above are passing vacuously and
    // this suite has stopped being evidence of anything.
    const seen = new Set<string>();
    const broken = [{ rel: 'a.ts' }, { rel: 'b.ts' }]
      .map((t) => t.rel)
      .filter((x) => !(seen.has(x) || seen.add(x)));
    expect(broken).toEqual([]);
  });
});

describe('the acquire payload and extractPathsFromToolInput cannot diverge', () => {
  const originalFetch = global.fetch;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevDir = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  let dir: string;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;
  let repo: string;

  beforeEach(async () => {
    fx = await makeWorktreeFixture();
    repo = fx.repo;
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    dir = await fs.mkdtemp(join(tmpdir(), 'su-locks-payload-'));
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = dir;
    _resetToolCallCacheForTests();
    _resetRequestDefectCountForTests();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevDir === undefined) delete process.env.PAPERCUSP_LOCKS_CACHE_DIR;
    else process.env.PAPERCUSP_LOCKS_CACHE_DIR = prevDir;
    await fs.rm(dir, { recursive: true, force: true });
    await fx.cleanup();
  });

  /** Capture the `paths` argument onToolCall actually puts on the wire. */
  async function pathsSentByOnToolCall(
    input: Record<string, unknown>,
  ): Promise<unknown> {
    let sent: unknown = '(no locks:acquire call was made)';
    global.fetch = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: { paths?: unknown } };
      };
      if (body.params.name === 'locks:acquire') sent = body.params.arguments.paths;
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [
                { type: 'text', text: JSON.stringify({ ok: true, lock_id: 'L-1' }) },
              ],
            },
          }),
      };
    }) as unknown as typeof fetch;
    await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: `tc-${Math.random()}`,
      input,
    });
    return sent;
  }

  it('sends a NON-EMPTY paths array for an ordinary single-file write', async () => {
    const sent = await pathsSentByOnToolCall({
      path: join(repo, 'apps', 'a.ts'),
      content: 'x',
    });
    // The precise assertion all 220 rejected calls would have failed.
    expect(sent).toEqual(['apps/a.ts']);
  });

  it('sends EXACTLY what extractPathsFromToolInput reports (one derivation, not two)', async () => {
    const input = { path: join(repo, 'apps', 'a.ts'), content: 'x' };
    const sent = await pathsSentByOnToolCall(input);
    expect(sent).toEqual(extractPathsFromToolInput('write', input));
    // …and both must agree with the target extraction they share.
    expect(sent).toEqual(lockKeysFromTargets(extractLockTargets('write', input)));
  });
});

describe('a REFUSED lock request is reported as a hook defect, not an outage', () => {
  const originalFetch = global.fetch;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevDir = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  let dir: string;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;
  let repo: string;

  beforeEach(async () => {
    fx = await makeWorktreeFixture();
    repo = fx.repo;
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    dir = await fs.mkdtemp(join(tmpdir(), 'su-locks-defect-'));
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = dir;
    _resetToolCallCacheForTests();
    _resetRequestDefectCountForTests();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevDir === undefined) delete process.env.PAPERCUSP_LOCKS_CACHE_DIR;
    else process.env.PAPERCUSP_LOCKS_CACHE_DIR = prevDir;
    await fs.rm(dir, { recursive: true, force: true });
    await fx.cleanup();
  });

  /** The operator ANSWERS and refuses the arguments (MCP isError + non-JSON text). */
  function refuseWithInvalidArgs(): void {
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'invalid_args: pass at least one repo-relative `paths` entry',
              },
            ],
          },
        }),
    })) as unknown as typeof fetch;
  }

  async function callOnce(id: string): Promise<{ block?: boolean }> {
    const origErr = console.error;
    console.error = () => {};
    try {
      return await onToolCall({
        type: 'tool_call',
        toolName: 'write',
        toolCallId: id,
        input: { path: join(repo, 'apps', 'a.ts'), content: 'x' },
      });
    } finally {
      console.error = origErr;
    }
  }

  it("writes last-request-defect.json — the marker a peer's success cannot clear", async () => {
    refuseWithInvalidArgs();
    await callOnce('tc-d1');
    const rec = JSON.parse(
      await fs.readFile(join(dir, 'last-request-defect.json'), 'utf8'),
    );
    expect(rec.handler).toBe('tool_call');
    expect(rec.count).toBe(1);
    expect(rec.detail).toContain('invalid_args');
  });

  it('counts CONSECUTIVE occurrences, so "off all session" is distinguishable from a blip', async () => {
    refuseWithInvalidArgs();
    await callOnce('tc-d1');
    await callOnce('tc-d2');
    await callOnce('tc-d3');
    const rec = JSON.parse(
      await fs.readFile(join(dir, 'last-request-defect.json'), 'utf8'),
    );
    // The measured incident was 220 of these. One is a bug; a rising count
    // is the "enforcement has been off for hours" signal.
    expect(rec.count).toBe(3);
  });

  it('records phase=request, NOT phase=connect (a refusal is not an outage)', async () => {
    refuseWithInvalidArgs();
    await callOnce('tc-d1');
    const rec = JSON.parse(await fs.readFile(join(dir, 'last-error.json'), 'utf8'));
    // phase=connect renders in /coord as "operator unreachable" — which is
    // how a deterministic schema bug read as transient for 220 calls.
    expect(rec.phase).toBe('request');
    expect(rec.phase).not.toBe('connect');
  });

  it('fails OPEN — a harness bug must never wedge the agent', async () => {
    refuseWithInvalidArgs();
    const r = await callOnce('tc-d1');
    expect(r.block).toBeUndefined();
  });

  it('CONTROL: a transport miss still records phase=connect and writes NO defect marker', async () => {
    // Calibration for the three assertions above: if an unreachable
    // operator also produced a request defect, they would pass for the
    // wrong reason and the distinction would mean nothing.
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await callOnce('tc-c1');
    const rec = JSON.parse(await fs.readFile(join(dir, 'last-error.json'), 'utf8'));
    expect(rec.phase).toBe('connect');
    await expect(
      fs.readFile(join(dir, 'last-request-defect.json'), 'utf8'),
    ).rejects.toThrow();
  });
});

describe('asStructuredCallError — refusal vs contention', () => {
  it('recognises the two structured error shapes preserveErrors can return', () => {
    expect(
      asStructuredCallError({
        ok: false,
        error: 'mcp_tool_error',
        message: 'invalid_args: …',
      }),
    ).toEqual({ error: 'mcp_tool_error', message: 'invalid_args: …' });
    expect(
      asStructuredCallError({ ok: false, error: 'mcp_rpc_error', message: 'bad method' }),
    ).toEqual({ error: 'mcp_rpc_error', message: 'bad method' });
  });

  it('does NOT treat a busy refusal as a hook defect — contention is a successful call', () => {
    // The distinction that matters: `ok: false` alone must not mean "our
    // arguments were wrong", or ordinary lock contention would raise a
    // standing "enforcement is broken" banner.
    expect(
      asStructuredCallError({ ok: false, busy: [{ path: 'a.ts', owner: 'peer' }] }),
    ).toBeNull();
    expect(asStructuredCallError({ ok: true, lock_id: 'L-1' })).toBeNull();
    expect(asStructuredCallError(null)).toBeNull();
  });
});
