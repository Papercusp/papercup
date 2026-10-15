import { expect, it } from 'vitest';
import { reloadPrivateHealthSnapshot, waitForPrivateHealthSnapshot } from '../../../test/portal-roster-browser-fixture';

function clock() {
  let time = 0;
  return { now: () => time, pause: async (ms: number) => { time += ms; }, timeoutMs: 2_000 };
}

it('waits for the selected workspace collector generation after an older successful response', async () => {
  const bodies = [
    { rows: [{ workspaceId: 'byoc-a', generation: 1 }] },
    { rows: [{ workspaceId: 'byoc-b', generation: 2 }] },
    { rows: [{ workspaceId: 'byoc-a', generation: 2 }] },
  ];
  let reads = 0;
  const body = await waitForPrivateHealthSnapshot(async () => bodies[reads++], 'byoc-a', row => row.generation === 2, clock());
  expect(body).toEqual(bodies[2]);
  expect(reads).toBe(3);
});

it.each(['byoc-a', 'byoc-b'])('fails at the deadline when %s never supplies the expected selected reading', async workspaceId => {
  let reads = 0;
  await expect(waitForPrivateHealthSnapshot(async () => {
    reads++;
    return { rows: [{ workspaceId, generation: workspaceId === 'byoc-a' ? 1 : 2 }] };
  }, 'byoc-a', row => row.generation === 2, clock())).rejects.toThrow('did not converge');
  expect(reads).toBe(3);
});

it('propagates query failures instead of disguising them as stale generations', async () => {
  await expect(waitForPrivateHealthSnapshot(async () => { throw new Error('private query denied'); },
    'byoc-a', () => true, clock())).rejects.toThrow('private query denied');
});

it('captures the Health response body before reload releases its network resource', async () => {
  const body = { rows: [{ workspaceId: 'byoc-a', generation: 2 }] };
  let released = false;
  let read = false;
  const response = { json: async () => {
    if (released) throw new Error('No resource with given identifier found');
    read = true;
    return body;
  } };
  let receive!: (value: typeof response) => void;
  let finishReload!: () => void;
  const page = {
    waitForResponse: () => new Promise<typeof response>(resolve => { receive = resolve; }),
    reload: async () => {
      receive(response);
      await new Promise<void>(resolve => { finishReload = resolve; });
      released = true;
    },
  } as unknown as Parameters<typeof reloadPrivateHealthSnapshot>[0];
  const pending = reloadPrivateHealthSnapshot(page);
  await Promise.resolve();
  const readBeforeReload = read;
  finishReload();
  expect(await pending).toEqual(body);
  expect(readBeforeReload).toBe(true);
});

it('preserves response body errors while reload is still pending', async () => {
  const failure = new Error('original response read failure');
  const page = {
    waitForResponse: async () => ({ json: async () => { throw failure; } }),
    reload: () => new Promise(() => {}),
  } as unknown as Parameters<typeof reloadPrivateHealthSnapshot>[0];
  await expect(reloadPrivateHealthSnapshot(page)).rejects.toBe(failure);
});
