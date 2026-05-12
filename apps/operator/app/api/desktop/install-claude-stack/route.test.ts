/**
 * Mocks node:child_process.spawn to drive the install-claude-stack
 * route through its multi-step SSE protocol (claude → meridian → omp).
 *
 * Asserts wire format on the failure-early-exit path and the
 * happy-path 'done' shape.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock spawn: each call returns a fake child whose exit code is controlled
// by the test via the `nextExitCode` shared variable.
let nextExitCode: number | null = 0;
let nextStdout: string[] = [];
let nextStderr: string[] = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn(() => {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child: EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (sig?: NodeJS.Signals) => void;
        pid: number;
      } = Object.assign(new EventEmitter(), {
        stdout, stderr,
        kill: () => {},
        pid: 99999,
      });
      // Defer emission so listeners get attached first.
      queueMicrotask(() => {
        for (const line of nextStdout) child.stdout.emit('data', Buffer.from(line));
        for (const line of nextStderr) child.stderr.emit('data', Buffer.from(line));
        child.emit('close', nextExitCode);
      });
      return child as unknown as ReturnType<typeof actual.spawn>;
    }),
  };
});

// Mock node:fs writeFileSync (called between claude + meridian) so we
// don't write to ~/.papercusp/runtime.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: vi.fn(() => true), // omp binary "found" + claude binary "found"
  };
});

import { POST } from './route';

function makeReq(): { req: Request; abort: () => void } {
  const controller = new AbortController();
  const req = new Request('http://x.test/api/desktop/install-claude-stack', {
    method: 'POST',
    signal: controller.signal,
  });
  return { req, abort: () => controller.abort() };
}

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let acc = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
  }
  return acc;
}

beforeEach(() => {
  nextExitCode = 0;
  nextStdout = [];
  nextStderr = [];
});

describe('install-claude-stack — SSE wire', () => {
  it('emits done(ok:true) on the happy path', async () => {
    nextStdout = ['installing...\n'];
    const { req } = makeReq();
    // Pass a NextRequest-shape via casting.
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const body = await readAll(res);
    expect(body).toContain('event: step');
    expect(body).toContain('event: log');
    expect(body).toContain('event: done');
    // Final done payload reports ok:true.
    const doneMatch = body.match(/event: done\ndata: (\{[^\n]+\})/);
    expect(doneMatch).toBeTruthy();
    const payload = JSON.parse(doneMatch![1]);
    expect(payload.ok).toBe(true);
  });

  it('emits done(ok:false) when the claude installer exits non-zero', async () => {
    nextExitCode = 1;
    nextStderr = ['error: download failed\n'];
    const { req } = makeReq();
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    const body = await readAll(res);
    const doneMatch = body.match(/event: done\ndata: (\{[^\n]+\})/);
    expect(doneMatch).toBeTruthy();
    const payload = JSON.parse(doneMatch![1]);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toMatch(/claude installer exited non-zero/);
    // After done, the stream closes — no further `step`/`log` frames.
    const after = body.slice(body.indexOf('event: done'));
    expect(after.split('\n').filter((l) => l.startsWith('event: step')).length).toBe(0);
  });

  it('CORS headers are preserved through the migration', async () => {
    const { req } = makeReq();
    const res = await POST(req as unknown as Parameters<typeof POST>[0]);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    // Drain so the test doesn't leak the spawn loop.
    await readAll(res);
  });
});
