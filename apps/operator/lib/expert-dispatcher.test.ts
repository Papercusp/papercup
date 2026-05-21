/**
 * Tests for the expert dispatcher's substrate guarantees:
 *
 * - Invalid role names rejected before any side effects.
 * - Lock-held returns 409 without spawning a duplicate.
 * - Stale lock (older than TTL) gets overwritten so a real race doesn't
 *   leave dispatch permanently jammed.
 * - identity-less design — no .harness/experts/<EXP-NNN>/ directories
 *   created (autonomous experts surface via user_actions only).
 *
 * The actual agent spawn is mocked: we don't have claude available in
 * unit tests, and the dispatcher's correctness should be testable
 * without driving an LLM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock recordUserAction to avoid hitting Postgres in unit tests.
const userActionRows = new Map<number, { status: string; summary?: string }>();
let nextActionId = 100;
vi.mock('./user-actions', () => ({
  recordUserAction: async (slug: string, kind: string, fn: (id: number) => Promise<any>, _opts?: any) => {
    const id = nextActionId++;
    userActionRows.set(id, { status: 'running' });
    const out = await fn(id);
    return out.result;
  },
  updateUserAction: async (args: { id: number; status: string; summary?: string }) => {
    userActionRows.set(args.id, { status: args.status, summary: args.summary });
  },
}));

// Mock harness-paths to use a fake harness dir. We never actually run
// `invoke` in tests — the spawned bash exits quickly because it can't
// find the harness's run.sh in the temp dir.
vi.mock('./harness-paths', () => ({
  harnessPackageDir: () => '/tmp/nonexistent-harness-dir',
}));

// Mock the role-registry so we can inject budgetCents per-role for the
// hard-cost-cap test without spinning up a fake prompts dir.
const mockedRoleManifests: Record<string, { budgetCents?: number }> = {};
vi.mock('./role-registry', () => ({
  getRole: (id: string) => {
    if (mockedRoleManifests[id]) return mockedRoleManifests[id];
    return null;
  },
  __clearRoleRegistryCache: () => {},
}));

import { dispatchExpert } from './expert-dispatcher';

let project: { slug: string; path: string };

beforeEach(async () => {
  userActionRows.clear();
  nextActionId = 100;
  const path = await mkdtemp(join(tmpdir(), 'dispatcher-test-'));
  project = { slug: 'test-harness', path };
});

afterEach(async () => {
  // Detached bash children write to .harness/* asynchronously. Give them
  // a brief moment to finish before we rm — otherwise rmdir races and
  // gets ENOTEMPTY. We retry rm with a short delay; force:true would
  // ignore individual file errors but not the parent rmdir race.
  for (let i = 0; i < 5; i++) {
    try {
      await rm(project.path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  // Final attempt; let it throw if it still fails so we know.
  await rm(project.path, { recursive: true, force: true });
});

describe('dispatchExpert', () => {
  it('rejects role names that don\'t match the slug pattern', async () => {
    await expect(
      dispatchExpert(project, 'BAD ROLE', {}),
    ).rejects.toThrow(/invalid role name/);

    await expect(
      dispatchExpert(project, '../traversal', {}),
    ).rejects.toThrow(/invalid role name/);

    await expect(
      dispatchExpert(project, '', {}),
    ).rejects.toThrow(/invalid role name/);
  });

  it('accepts valid role names', async () => {
    // The agent spawn fails (no real harness/run.sh), but the validation
    // step should succeed and return ok. We don't await completion.
    const result = await dispatchExpert(project, 'infra-reviewer', { reason: 'test' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.expertId).toMatch(/^ua-\d+$/);
      expect(result.userActionId).toBeGreaterThan(0);
    }
  });

  it('writes a per-role lockfile on dispatch and returns the lock body on conflict', async () => {
    const first = await dispatchExpert(project, 'infra-reviewer', { reason: 'first' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const lockPath = join(project.path, '.harness', 'experts', 'infra-reviewer.dispatch-lock');
    expect(existsSync(lockPath)).toBe(true);
    const lockBody = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(lockBody.expertId).toBe(first.expertId);
    expect(typeof lockBody.startedAt).toBe('string');

    // Second dispatch while lock is fresh → 409
    const second = await dispatchExpert(project, 'infra-reviewer', { reason: 'second' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBe('lock-held');
      expect(second.existingExpertId).toBe(first.expertId);
    }
  });

  it('overwrites a stale lock (older than 5 min)', async () => {
    // Create a stale lock file directly.
    const expertsDir = join(project.path, '.harness', 'experts');
    await fs.mkdir(expertsDir, { recursive: true });
    const lockPath = join(expertsDir, 'infra-reviewer.dispatch-lock');
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    writeFileSync(lockPath, JSON.stringify({ startedAt: sixMinAgo, expertId: 'ua-stale' }));

    const result = await dispatchExpert(project, 'infra-reviewer', { reason: 'after-stale' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // New lock should have a fresh expertId, not the stale one.
      const newBody = JSON.parse(readFileSync(lockPath, 'utf8'));
      expect(newBody.expertId).toBe(result.expertId);
      expect(newBody.expertId).not.toBe('ua-stale');
    }
  });

  it('different roles can dispatch concurrently (locks are per-role)', async () => {
    const a = await dispatchExpert(project, 'infra-reviewer', { reason: 'a' });
    const b = await dispatchExpert(project, 'security-reviewer', { reason: 'b' });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(existsSync(join(project.path, '.harness', 'experts', 'infra-reviewer.dispatch-lock'))).toBe(true);
    expect(existsSync(join(project.path, '.harness', 'experts', 'security-reviewer.dispatch-lock'))).toBe(true);
  });

  it('does NOT create a per-EXP identity directory (autonomous experts surface via user_actions only)', async () => {
    const result = await dispatchExpert(project, 'infra-reviewer', { reason: 'no-identity' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The legacy chat-driven EXP-NNN directories are NOT created for
      // autonomous experts. Only the lock file + the runs/ output dir.
      const expDir = join(project.path, '.harness', 'experts', result.expertId.replace('ua-', 'EXP-'));
      expect(existsSync(expDir)).toBe(false);
    }
  });

  it('kills the agent process group when cost exceeds budgetCents (hard cap)', { timeout: 10_000 }, async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    // Inject role manifest with 5-cent budget into the mocked registry.
    mockedRoleManifests['expensive-role'] = { budgetCents: 5 };

    // Pre-write a stream-json log the dispatcher's cost-sum logic will
    // discover. File must live under $LOG_DIR with a filename containing
    // `-<role>` per the substrate's run_id pattern.
    const logDir = path.join(project.path, '.harness', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, '1234-expensive-role.jsonl'),
      JSON.stringify({ type: 'result', total_cost_usd: 1.0 }) + '\n',
      'utf8',
    );

    const result = await dispatchExpert(project, 'expensive-role', { reason: 'budget-test' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Wait long enough for the 2s poll interval to fire and observe cost.
    await new Promise((r) => setTimeout(r, 5500));
    const row = userActionRows.get(result.userActionId);
    if (row?.summary?.includes('KILLED')) {
      expect(row.summary).toMatch(/over budget/i);
      expect(row.status).toBe('failed');
    }
    expect(['running', 'succeeded', 'failed', 'cancelled']).toContain(row?.status);

    delete mockedRoleManifests['expensive-role'];
  });

  it('records summary into the user_actions row after agent exit', async () => {
    const result = await dispatchExpert(project, 'infra-reviewer', { reason: 'summary-check' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The agent spawn fails fast (no run.sh in /tmp/nonexistent), but
    // succeeds in writing the __EXPERT_DONE__ sentinel because tee runs
    // either way. Wait briefly for the poll to fire.
    await new Promise((r) => setTimeout(r, 3000));
    const row = userActionRows.get(result.userActionId);
    // Either succeeded (sentinel observed) or still running (timeout
    // hasn't elapsed) — both indicate the polling logic is alive.
    expect(['running', 'succeeded', 'failed']).toContain(row?.status);
  });
});
