/**
 * su-locks-omp-smoke.ts — the two-agent OMP-hook coordination test.
 *
 * This is "the test we never ran" from file-locking-improvements §14
 * (system-level acceptance #1): two OMP agents target the same file;
 * the second must be HARD-BLOCKED, not merely told.
 *
 * Why this shape — and why it does NOT need a live operator:
 *
 *   The OMP hook (scripts/hooks/omp/coord-hook.ts) has two layers.
 *   (a) Pure, filesystem-local decisions: path extraction
 *       (extractPathsFromToolInput) and symlink refusal
 *       (detectSymlinkedPaths) — file-locking #1/#2. These run inside
 *       onToolCall BEFORE any operator round-trip.
 *   (b) The lock acquire/release itself, which the hook delegates to
 *       the SU-locks store over MCP. The store is PG-backed; the
 *       transport is the only operator-dependent part.
 *
 *   This smoke exercises (a) through the hook's REAL exported code and
 *   (b) directly against the embedded `papercusp_su` PG via the same
 *   store the MCP tool calls — with owner ids minted in the EXACT
 *   `omp-<session>-<pid>` shape hookOwnerId() produces. Two distinct
 *   PAPERCUSP_AUTH_SESSION_ID values ⇒ two distinct owners, exactly as
 *   two OMP terminals would have. The MCP hop adds no lock semantics
 *   the store does not already enforce; skipping it keeps the smoke
 *   deterministic and runnable with no desktop process. The live-HTTP
 *   path is covered separately by su-locks-e2e.sh.
 *
 * Run:  npx tsx apps/operator/scripts/su-locks-omp-smoke.ts
 * Exit: 0 = all checks passed, 1 = assertion failed, 2 = crashed.
 */

import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureBootstrap,
  getTxPool,
  normalizePaths,
  tryAcquire,
  tryRelease,
  readQueue,
  _resetForTests,
} from '../lib/agent-tools/locks/su-lock-store.ts';
import { inWorkspaceTxn } from '../lib/agent-tools/locks/in-workspace-txn.ts';
import {
  extractPathsFromToolInput,
  detectSymlinkedPaths,
  hookOwnerId,
  onToolCall,
  _resetHookOwnerIdForTests,
} from './hooks/omp/coord-hook.ts';

let step = 0;
function ok(msg: string): void {
  step += 1;
  console.log(`  ✓ ${step}. ${msg}`);
}
function fail(msg: string): never {
  console.error(`  ✗ FAIL: ${msg}`);
  process.exit(1);
}

/** Mint an owner id the way an OMP terminal with this session would. */
function ompOwner(sessionId: string): string {
  process.env.PAPERCUSP_AUTH_SESSION_ID = sessionId;
  _resetHookOwnerIdForTests();
  return hookOwnerId();
}

async function main(): Promise<void> {
  console.log('su-locks OMP two-agent smoke\n');

  // A throwaway repo root so extractPathsFromToolInput resolves
  // predictable repo-relative paths (it reads PAPERCUSP_REPO_ROOT).
  const repoRoot = await mkdtemp(join(tmpdir(), 'omp-smoke-repo-'));
  await mkdir(join(repoRoot, 'apps'), { recursive: true });
  await writeFile(join(repoRoot, 'apps', 'target.ts'), '// smoke\n');
  process.env.PAPERCUSP_REPO_ROOT = repoRoot;
  // No operator configured: if a symlink check were ever skipped,
  // onToolCall would fall through to callMcpTool, get null, and
  // fail OPEN ({}). So a {block:true} below can ONLY come from the
  // local symlink refusal — never from a phantom operator answer.
  delete process.env.PAPERCUSP_BUNDLE_URL;
  delete process.env.PAPERCUSP_OPERATOR_URL;

  const ws = `omp-smoke-ws-${Date.now()}`;
  const sql = getTxPool();

  try {
    await ensureBootstrap();
    ok('embedded papercusp_su PG bootstrapped');

    // ── Two distinct OMP identities ─────────────────────────────────
    const ownerA = ompOwner('pus-omp-smoke-A');
    const ownerB = ompOwner('pus-omp-smoke-B');
    if (ownerA === ownerB) fail(`two sessions collapsed to one owner: ${ownerA}`);
    if (!ownerA.startsWith('omp-') || !ownerB.startsWith('omp-')) {
      fail(`owner ids are not omp-<session>-<pid>: ${ownerA} / ${ownerB}`);
    }
    ok(`two OMP sessions → distinct owners (${ownerA} vs ${ownerB})`);

    // ── Agent A: extract the claim path the way the hook does ───────
    const writeInput = { path: join(repoRoot, 'apps', 'target.ts'), content: 'x' };
    const pathsA = extractPathsFromToolInput('write', writeInput);
    if (pathsA.length !== 1 || pathsA[0] !== 'apps/target.ts') {
      fail(`extractPathsFromToolInput → ${JSON.stringify(pathsA)}`);
    }
    ok('hook extracts repo-relative claim path from a write tool_call');

    const a = await inWorkspaceTxn(ws, ownerA, (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: ownerA,
        ownerLabel: 'omp:A',
        paths: normalizePaths(pathsA),
        intent: 'omp smoke: agent A edits target.ts',
        ttlSec: 60,
      }),
    );
    if (!a.ok) fail(`agent A acquire was refused: ${JSON.stringify(a)}`);
    ok('agent A acquires apps/target.ts');

    // ── Agent B: same file, different owner → MUST be hard-blocked ──
    const b = await inWorkspaceTxn(ws, ownerB, (tx) =>
      tryAcquire(tx, {
        coordinationDomain: ws,
        owner: ownerB,
        ownerLabel: 'omp:B',
        paths: normalizePaths(extractPathsFromToolInput('write', writeInput)),
        intent: 'omp smoke: agent B also wants target.ts',
        ttlSec: 60,
      }),
    );
    if (b.ok) fail('agent B was GRANTED a lock on a file agent A holds');
    const holder = b.busy.find((e) => e.path === 'apps/target.ts');
    if (!holder) fail(`agent B busy[] does not name apps/target.ts: ${JSON.stringify(b.busy)}`);
    if (holder.owner !== ownerA) {
      fail(`busy entry blames ${holder.owner}, expected holder ${ownerA}`);
    }
    ok('agent B is hard-blocked — busy entry correctly names agent A as holder');

    // ── The lock is visible in the queue with both owners distinct ──
    const q = await readQueue(sql, { coordinationDomain: ws });
    const active = q.active_locks.find((l) => l.path === 'apps/target.ts');
    if (!active || active.owner !== ownerA) {
      fail(`queue does not show apps/target.ts held by agent A: ${JSON.stringify(q.active_locks)}`);
    }
    ok('locks:queue shows the lock attributed to agent A');

    // ── Symlink refusal closes the aliasing sidestep (#1) ───────────
    // Without this, agent B could dodge the block by editing a symlink
    // that points at apps/target.ts — a different path STRING, so the
    // store would not collide. The hook refuses the symlink outright.
    await symlink(join(repoRoot, 'apps', 'target.ts'), join(repoRoot, 'apps', 'alias.ts'));
    const hits = detectSymlinkedPaths(['apps/alias.ts'], repoRoot);
    if (hits.length !== 1 || hits[0].real !== 'apps/target.ts') {
      fail(`detectSymlinkedPaths did not flag the alias: ${JSON.stringify(hits)}`);
    }
    ok('hook detects apps/alias.ts → apps/target.ts as a symlink');

    const blocked = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'omp-smoke-symlink',
      input: { path: join(repoRoot, 'apps', 'alias.ts'), content: 'x' },
    });
    if (blocked.block !== true) {
      fail(`onToolCall did NOT block the symlinked edit: ${JSON.stringify(blocked)}`);
    }
    if (!/symlink/i.test(blocked.reason ?? '')) {
      fail(`symlink refusal reason is unclear: ${JSON.stringify(blocked.reason)}`);
    }
    ok('onToolCall hard-blocks the symlinked edit — sidestep closed');

    // ── Release frees the file; the queue empties ───────────────────
    const rel = await inWorkspaceTxn(ws, ownerA, (tx) =>
      tryRelease(tx, { coordinationDomain: ws, owner: ownerA, lockId: a.lock_id }),
    );
    if (rel.released.length !== 1) fail(`release freed ${rel.released.length} paths, expected 1`);
    const q2 = await readQueue(sql, { coordinationDomain: ws });
    if (q2.active_locks.length !== 0) {
      fail(`queue not empty after release: ${JSON.stringify(q2.active_locks)}`);
    }
    ok('agent A releases — queue is empty, file is free again');

    console.log('\n[OK] ALL OMP TWO-AGENT SMOKE CHECKS PASSED');
  } finally {
    await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
    await _resetForTests().catch(() => {});
  }
}

main().catch((e) => {
  console.error('CRASH:', e);
  process.exit(2);
});
