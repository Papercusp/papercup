/**
 * waitForOperatorReady (EI-368): readiness gating + fail-fast on child death.
 * Hermetic — a local http server plays the operator; an EventEmitter plays the
 * spawned child.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { bootLogTail, waitForOperatorReady } from './operator-ready';

/** Minimal stand-in for the spawned operator process. */
function fakeChild(exitCode: number | null = null): ChildProcess & { die: (code: number, signal?: NodeJS.Signals) => void } {
  const em = new EventEmitter() as EventEmitter & { exitCode: number | null; die: (code: number, signal?: NodeJS.Signals) => void };
  em.exitCode = exitCode;
  em.die = (code: number, signal?: NodeJS.Signals) => {
    em.exitCode = code;
    em.emit('exit', code, signal ?? null);
  };
  return em as unknown as ChildProcess & { die: (code: number, signal?: NodeJS.Signals) => void };
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function serve(handler: (path: string) => { status: number; body?: string }): Promise<string> {
  const srv = createServer((req, res) => {
    const { status, body } = handler(req.url ?? '/');
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body ?? '{}');
  });
  servers.push(srv);
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

describe('waitForOperatorReady', () => {
  it('resolves once /api/health/ready reports ready', async () => {
    let calls = 0;
    const base = await serve((path) => {
      if (path === '/api/health/ready') {
        calls += 1;
        // 503 (booting) on the first probe, ready on the second — the DBOS gate.
        return calls < 2 ? { status: 503 } : { status: 200, body: '{"ok":true,"dbos":true}' };
      }
      return { status: 404 };
    });
    await waitForOperatorReady({ baseUrl: base, timeoutMs: 10_000, pollMs: 20 });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('falls back to llms.txt liveness when the ready route is absent (older pinned checkout)', async () => {
    let livenessProbed = false;
    const base = await serve((path) => {
      if (path === '/api/health/ready') return { status: 404 };
      if (path === '/llms.txt') {
        livenessProbed = true;
        return { status: 200, body: 'ok' };
      }
      return { status: 404 };
    });
    await waitForOperatorReady({ baseUrl: base, timeoutMs: 10_000, pollMs: 20 });
    expect(livenessProbed).toBe(true);
  });

  it('fails fast with code + boot-log tail when the child dies mid-boot', async () => {
    const base = await serve(() => ({ status: 503 })); // never becomes ready
    const dir = mkdtempSync(join(tmpdir(), 'gym-ready-'));
    const logPath = join(dir, 'op.log');
    writeFileSync(logPath, "Running DBOS system database migrations...\nterminate called after throwing an instance of 'Napi::Error'\n");
    const child = fakeChild();
    const p = waitForOperatorReady({ baseUrl: base, child, timeoutMs: 60_000, pollMs: 20, logPath });
    const started = Date.now();
    setTimeout(() => child.die(134, 'SIGABRT'), 30);
    await expect(p).rejects.toThrow(/exited during boot \(code=134, signal=SIGABRT\)[\s\S]*Napi::Error/);
    // Fail-FAST: rejected on the next poll after death, not at the 60s timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rejects immediately when the child already exited before the wait began', async () => {
    const base = await serve(() => ({ status: 503 }));
    const child = fakeChild(1); // exitCode already set — death raced the spawn
    await expect(
      waitForOperatorReady({ baseUrl: base, child, timeoutMs: 60_000, pollMs: 20 }),
    ).rejects.toThrow(/exited during boot \(code=1/);
  });

  it('rejects with the log tail at timeout when the operator never becomes ready', async () => {
    const base = await serve(() => ({ status: 503 }));
    const dir = mkdtempSync(join(tmpdir(), 'gym-ready-'));
    const logPath = join(dir, 'op.log');
    writeFileSync(logPath, 'still migrating…\n');
    await expect(
      waitForOperatorReady({ baseUrl: base, timeoutMs: 100, pollMs: 20, logPath }),
    ).rejects.toThrow(/not ready on[\s\S]*still migrating/);
  });
});

describe('bootLogTail', () => {
  it('returns the last N lines and is safe on a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gym-ready-'));
    const logPath = join(dir, 'op.log');
    writeFileSync(logPath, Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n'));
    const tail = bootLogTail(logPath, 5);
    expect(tail).toContain('line-29');
    expect(tail).not.toContain('line-24\n');
    expect(bootLogTail(join(dir, 'absent.log'))).toBe('');
    expect(bootLogTail(undefined)).toBe('');
  });
});
