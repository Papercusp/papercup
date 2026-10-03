import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTextCollector } from '../child-output';
import { LIVE_HEALTH_MONITOR_READY_PREFIX } from './live-health-monitor-main';

const REPO_ROOT = join(import.meta.dirname, '../../../../');
const BIN = join(import.meta.dirname, 'live-health-monitor-bin.ts');
const children = new Set<ChildProcess>();
const roots: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function waitForReady(child: ChildProcess, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // Boundary-safe incremental read — see createTextCollector.peek().
    const collector = createTextCollector();
    let consumedChars = 0;
    const timeout = setTimeout(() => reject(new Error(`monitor readiness timed out after ${timeoutMs}ms`)), timeoutMs);
    const finish = (error: Error | null, line = '') => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(line);
    };
    collector.attach(child.stdout);
    child.stdout?.on('data', () => {
      const all = collector.peek();
      const lines = all.slice(consumedChars).split('\n');
      const partial = lines.pop() ?? '';
      consumedChars = all.length - partial.length;
      const ready = lines.find((line) => line.startsWith(LIVE_HEALTH_MONITOR_READY_PREFIX));
      if (ready) finish(null, ready);
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) =>
      finish(new Error(`monitor exited before ready (${signal ?? code ?? 'unknown'})`)),
    );
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`monitor did not exit after stdin close within ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe('resource-governor live-health out-of-process monitor', () => {
  it('boots, writes a whole atomic snapshot, and follows the parent-owned stdin lifetime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'papercusp-live-health-'));
    roots.push(root);
    const childEnv = { ...process.env };
    delete childEnv.VITEST;
    childEnv.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR = root;
    const child = spawn('npx', ['tsx', BIN], {
      cwd: REPO_ROOT,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
    children.add(child);
    const ready = await waitForReady(child);
    expect(ready).toContain('resource-governor-live-health-v2');

    const snapshot = JSON.parse(await readFile(join(root, 'live-health.json'), 'utf8')) as {
      schemaVersion: string;
      sequence: number;
      profile: { source: string; effectiveCores: number };
      writers: Record<string, unknown>;
      signals: Record<string, { state: string; value: unknown }>;
      observations: Record<string, Record<string, unknown>>;
    };
    expect(snapshot.schemaVersion).toBe('resource-governor-live-health-v2');
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.profile).toMatchObject({ source: '@papercusp/resource-profile' });
    expect(snapshot.profile.effectiveCores).toBeGreaterThan(0);
    expect(Object.keys(snapshot.writers).some((id) => id.startsWith('monitor.host:'))).toBe(true);
    expect(snapshot.signals['memory.hostUsedBytes']).toMatchObject({ state: 'measured' });
    expect(snapshot.signals['database.waitP95Ms']).toEqual(expect.objectContaining({ state: 'unknown', value: null }));
    expect(snapshot.observations['memory.hostUsedBytes']).toBeTruthy();

    child.stdin?.end();
    await waitForExit(child);
    children.delete(child);
  }, 30_000);
});
