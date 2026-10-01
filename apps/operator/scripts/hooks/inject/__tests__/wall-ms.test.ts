/**
 * The injection hook tells the operator its own wall (WI-10004485 step C), so the
 * Jev memory filter waits only for what is left of it (operator-core
 * jev-memory-gate.ts: jevMemoryWaitMs; turn-start-memory.ts turns `wallMs` into
 * respondByMs). The number is each port spec's timeoutMs, sent with every
 * request, never a second copy kept on the server.
 *
 * Lives beside core.mjs on purpose: test selection is by workspace, so a test in
 * another package would not run when this hook changes.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { postInjection } = await import(path.join(HERE, '..', 'core.mjs'));
const { PORTS } = (await import(path.join(HERE, '..', 'ports.mjs'))) as {
  PORTS: Record<string, { timeoutMs: number }>;
};

describe('injection hook → operator: the wall travels with the request', () => {
  it('covers at least one port (positive control: an empty PORTS would pass every case vacuously)', () => {
    expect(Object.keys(PORTS).length).toBeGreaterThan(0);
  });

  it.each(Object.keys(PORTS))('port %s sends wallMs equal to its own timeoutMs, alongside the caller’s body', async (port) => {
    const sent: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Record<string, unknown>);
      return { ok: true, json: async () => ({ text: 'x' }) };
    }) as unknown as typeof fetch;

    await postInjection(port, { owner: 'su-test', prompt: 'hello' }, { env: {}, fetchImpl });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ owner: 'su-test', prompt: 'hello', wallMs: PORTS[port]!.timeoutMs });
  });
});
