import { once } from 'node:events';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { describeObserverBlock, OBSERVER_BLOCK_REPORT_MS, pollUntil } from './poll-until';

/**
 * Blocks this thread synchronously, as a long synchronous call in the vitest
 * worker does: no timer, socket read or PTY read runs until it returns.
 */
function blockEventLoop(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The deadline loop the PTY fixtures hand-rolled before `pollUntil` existed,
 * kept verbatim as the control: it is what the stall scenario must defeat.
 */
async function legacyWait(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return false;
}

const opened: Array<Server | Socket> = [];

afterEach(async () => {
  for (const handle of opened.splice(0)) {
    if ('destroy' in handle) handle.destroy();
    else await new Promise((resolve) => handle.close(resolve));
  }
});

/**
 * A loopback socket pair standing in for the PTY: `received` accumulates what
 * the reading side has delivered to this process, exactly as the fixtures'
 * `onData` handler accumulates rendered output.
 */
async function socketPair(): Promise<{ writer: Socket; received: () => string }> {
  let data = '';
  const server = createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => { data += chunk; });
    opened.push(socket);
    server.emit('test-accepted');
  });
  opened.push(server);
  const accepted = once(server, 'test-accepted');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback server has no port');
  const writer = connect(address.port, '127.0.0.1');
  opened.push(writer);
  await once(writer, 'connect');
  await accepted;
  return { writer, received: () => data };
}

/**
 * The WI-10003175 shape: the output the wait is looking for is written while
 * the waiter sleeps, and then this thread is blocked well past the deadline
 * before the waiter's timer can run. The bytes are in the kernel buffer the
 * whole time; only a waiter that reads them after the block can see them.
 */
async function stallScenario<T>(
  wait: (check: () => boolean) => Promise<T>,
): Promise<T> {
  const { writer, received } = await socketPair();
  const pending = wait(() => received().includes('frame'));
  // Registered before the waiter's own 60ms sleep, so it runs first.
  setTimeout(() => {
    writer.write('frame');
    blockEventLoop(400);
  }, 60);
  return await pending;
}

describe('pollUntil when the observing event loop is blocked', () => {
  test('the stall scenario defeats the hand-rolled deadline loop (control)', async () => {
    expect(await stallScenario((check) => legacyWait(check, 150))).toBe(false);
  });

  test('reads output that arrived during the block and reports how long it was', async () => {
    const outcome = await stallScenario((check) => pollUntil(check, { timeoutMs: 150 }));
    expect(outcome.ok).toBe(true);
    // The sleep was due 60ms in and could not run until the 400ms block ended.
    expect(outcome.maxLateMs).toBeGreaterThanOrEqual(250);
  });

  test('a check that itself outlasts the deadline gets one more look', async () => {
    let calls = 0;
    const outcome = await pollUntil(() => {
      calls += 1;
      if (calls === 1) {
        blockEventLoop(150);
        return false;
      }
      return true;
    }, { timeoutMs: 50 });
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('pollUntil deadline behaviour', () => {
  test('succeeds on the first check without sleeping', async () => {
    let misses = 0;
    const outcome = await pollUntil(() => true, { timeoutMs: 1_000, onMiss: () => { misses += 1; } });
    expect(outcome).toEqual({ ok: true, maxLateMs: 0 });
    expect(misses).toBe(0);
  });

  test('gives up only on a check that began after the deadline', async () => {
    const startedAt: number[] = [];
    let misses = 0;
    const timeoutMs = 200;
    const before = Date.now();
    const outcome = await pollUntil(() => {
      startedAt.push(Date.now());
      return false;
    }, { timeoutMs, intervalMs: 20, onMiss: () => { misses += 1; } });
    expect(outcome.ok).toBe(false);
    expect(startedAt.length).toBeGreaterThan(1);
    expect(startedAt[startedAt.length - 1]).toBeGreaterThanOrEqual(before + timeoutMs);
    // onMiss runs before every sleep, and no sleep follows the final check.
    expect(misses).toBe(startedAt.length - 1);
  });

  test('awaits an asynchronous check', async () => {
    let calls = 0;
    const outcome = await pollUntil(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return calls === 3;
    }, { timeoutMs: 2_000, intervalMs: 10 });
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(3);
  });
});

describe('describeObserverBlock', () => {
  test('says nothing about an ordinary wait', () => {
    expect(describeObserverBlock(0)).toBe('');
    expect(describeObserverBlock(OBSERVER_BLOCK_REPORT_MS - 1)).toBe('');
  });

  test('names a block and its length once it reaches the report threshold', () => {
    const suffix = describeObserverBlock(12_980);
    expect(suffix).toContain('blocked for up to 12980ms');
    expect(suffix).toContain('test worker');
    expect(describeObserverBlock(OBSERVER_BLOCK_REPORT_MS)).not.toBe('');
  });
});
