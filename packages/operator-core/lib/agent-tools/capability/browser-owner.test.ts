import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPrimaryOwnerRpcRelay, type OwnerRpcWorkerLike } from '../../cluster-owner-rpc';

// Real process/session/relay boundary, deterministic browser adapter. Real Chromium
// journeys and actual task-ledger/confinement acceptance are separate evidence.
const workers: Record<string, OwnerRpcWorkerLike> = {};
const listeners = new Set<(worker: unknown, message: unknown) => void>();
const children: ChildProcess[] = []; const events: any[] = [];
let relay: ReturnType<typeof startPrimaryOwnerRpcRelay>; let seq = 0;
async function start() {
  const child = fork(fileURLToPath(new URL('./__fixtures__/browser-owner-worker.mts', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  children.push(child);
  const worker: OwnerRpcWorkerLike = { process: { pid: child.pid }, send: (m) => child.send(m as never),
    isDead: () => child.exitCode !== null || child.signalCode !== null, isConnected: () => child.connected };
  workers[String(child.pid)] = worker;
  child.on('message', (m) => { events.push(m); for (const listener of listeners) listener(worker, m); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser owner fixture startup timed out')), 30_000);
    child.on('message', (m: any) => { if (m?.type === 'fixture:ready') { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`browser fixture exited ${code}`)); });
  });
  return child;
}
function request(child: ChildProcess, args: Record<string, unknown>) {
  const callSeq = ++seq;
  const result = new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error(`browser call ${callSeq} timed out`)); }, 15_000);
    const receive = (m: any) => {
      if (m?.type === 'fixture:result' && m.seq === callSeq) {
        clearTimeout(timer); child.off('message', receive);
        if (m.error) reject(new Error(m.error)); else resolve(m.result);
      }
    };
    child.on('message', receive); child.send({ type: 'fixture:call', seq: callSeq, ...args });
  });
  return { seq: callSeq, result };
}
async function call(child: ChildProcess, args: Record<string, unknown>) {
  const result = await request(child, args).result; return { result, body: JSON.parse(result.content[0].text) };
}
let a: ChildProcess; let b: ChildProcess;
beforeAll(async () => {
  relay = startPrimaryOwnerRpcRelay({ cluster: { workers, on: (_e, cb) => listeners.add(cb), off: (_e, cb) => listeners.delete(cb) } });
  [a, b] = await Promise.all([start(), start()]);
}, 45_000);
afterAll(async () => {
  relay?.stop();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
});
describe('browser follow-ups across request workers', () => {
  it('keeps the page on A and current profile/fetch/opaque principal on B, preserving binary media', async () => {
    const opened = await call(a, { args: { op: 'open' } }); expect(opened.body.ok).toBe(true);
    const id = opened.body.browser.id;
    const current = request(b, { args: { op: 'navigate', id, screenshot: true }, url: 'https://example.com/' });
    const result = await current.result; const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ ok: true, observation: { title: String(a.pid), text: '[0,127,255]', navigations: 1 } });
    expect(result.content[1]).toMatchObject({ type: 'image', data: Buffer.from([0, 127, 255]).toString('base64') });
    expect(events).toContainEqual(expect.objectContaining({ type: 'fixture:fetch', seq: current.seq, pid: b.pid, principalStayedLocal: true }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'fixture:release', seq: current.seq, pid: b.pid }));
    expect(events.filter(e => e.type === 'fixture:launch' && e.pid === b.pid)).toHaveLength(0);
    expect((await call(a, { args: { op: 'observe', id } })).body.observation.navigations).toBe(1);
    expect((await call(b, { args: { op: 'close', id } })).body.browser.state).toBe('closed');
  });
  it('refuses foreign owner/workspace/harness and rechecks changed current authority', async () => {
    const { body } = await call(a, { args: { op: 'open' } }); const id = body.browser.id;
    for (const foreign of [{ owner: 'other' }, { workspace: 'other' }, { harness: 'other' }]) {
      expect((await call(b, { ...foreign, args: { op: 'close', id } })).body.error).toBe('browser_unrecoverable');
    }
    expect((await call(b, { args: { op: 'observe', id } })).body.ok).toBe(true);
    expect((await call(b, { confined: true, args: { op: 'navigate', id }, url: 'https://example.com/' })).body.error).toBe('browser_authority_changed');
    expect((await call(a, { args: { op: 'observe', id } })).body.error).toBe('browser_unrecoverable');
  });
  it('propagates current caller denial, cancellation, overlap and sibling close without another launch', async () => {
    const { body } = await call(a, { args: { op: 'open' } }); const id = body.browser.id;
    expect((await call(b, { denyFetch: true, args: { op: 'navigate', id }, url: 'https://example.com/' })).body)
      .toMatchObject({ ok: false, networkFailures: [expect.stringContaining('current_caller_denied')] });
    const other = (await call(a, { args: { op: 'open' } })).body.browser.id;
    const entered = new Promise<void>((resolve) => {
      const receive = (m: any) => { if (m.type === 'fixture:fetch') { b.off('message', receive); resolve(); } }; b.on('message', receive);
    });
    const running = request(b, { hangFetch: true, args: { op: 'navigate', id: other }, url: 'https://example.com/' });
    await entered;
    expect((await call(b, { args: { op: 'observe', id: other } })).body.error).toBe('browser_busy');
    await request(b, { op: 'cancel', runSeq: running.seq }).result;
    expect(JSON.parse((await running.result).content[0].text).ok).toBe(false);
    expect((await call(b, { args: { op: 'close', id: other } })).body.browser.state).toBe('closed');
  });
  it('reports owner SIGKILL and unknown handles as unrecoverable without replacement', async () => {
    const { body } = await call(a, { args: { op: 'open' } }); const id = body.browser.id;
    a.kill('SIGKILL'); await once(a, 'exit');
    expect((await call(b, { args: { op: 'observe', id } })).body).toMatchObject({ error: 'browser_unrecoverable', restartRecovery: 'unrecoverable' });
    expect((await call(b, { args: { op: 'observe', id: crypto.randomUUID() } })).body.error).toBe('browser_unrecoverable');
    expect(events.filter(e => e.type === 'fixture:launch' && e.pid === b.pid)).toHaveLength(0);
  });
});
