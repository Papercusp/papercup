/**
 * coord-tools.test.ts — plan harness-test-coverage-for-launch P-026.
 *
 * The coord TOOL handlers wrap the (already-tested) channel library + identity.
 * This pins the handler envelopes for whoami / thread / ack over an in-memory
 * coordLog with a mocked identity — the layer that had no coverage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCoordLog } from '@papercusp/coordination/event-log';
import { configureCoordLog, resetCoordLog } from '../log';
import { sendMessage } from '../messages';
import type { AgentIdentity } from '../identity';

const ME: AgentIdentity = {
  ownerId: 'me',
  ownerLabel: 'Me',
  source: 'omp-hook-session',
  workspaceId: 'default',
  userId: null,
};
vi.mock('../identity', () => ({ resolveAgentIdentity: () => ME }));

import whoamiTool from '../tools/whoami';
import ackTool from '../tools/ack';
import threadTool from '../tools/thread';

const id = (ownerId: string): AgentIdentity => ({
  ownerId,
  ownerLabel: ownerId,
  source: 'omp-hook-session',
  workspaceId: 'default',
  userId: null,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tool: any, args: Record<string, unknown> = {}) => tool.handler(args as any, {} as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parse = (res: any) => JSON.parse(res.content[0].text);

beforeEach(() => configureCoordLog(new InMemoryCoordLog()));
afterEach(() => resetCoordLog());

describe('coord:whoami', () => {
  it('returns the server-resolved coordination identity', async () => {
    expect(parse(await run(whoamiTool))).toMatchObject({ ownerId: 'me', source: 'omp-hook-session' });
  });
});

describe('coord:thread', () => {
  it('reconstructs the thread rooted at a message (root + its ack)', async () => {
    const m = await sendMessage(id('alice'), { to: ['*'], summary: 'heads up' });
    await sendMessage(id('bob'), { to: ['alice'], kind: 'ack', related_msg_id: m.msg_id });

    const body = parse(await run(threadTool, { root_msg_id: m.msg_id }));
    expect(body.root).toBe(m.msg_id);
    const ids = body.entries.map((e: { msg_id: string }) => e.msg_id);
    expect(ids).toContain(m.msg_id);
    expect(body.entries.some((e: { kind: string }) => e.kind === 'ack')).toBe(true);
  });
});

describe('coord:ack', () => {
  it('acks a real message back to its sender', async () => {
    const m = await sendMessage(id('alice'), { to: ['*'], summary: 'please review' });
    const body = parse(await run(ackTool, { msg_id: m.msg_id }));
    expect(body.ok).toBe(true);
    expect(body.acked).toBe(m.msg_id);
    expect(body.acked_from).toBe('alice'); // addressed back at the sender
    expect(body.ack_msg_id).toBeTruthy();

    // The ack is now in the thread.
    const thread = parse(await run(threadTool, { root_msg_id: m.msg_id }));
    expect(thread.entries.some((e: { kind: string; from: string }) => e.kind === 'ack' && e.from === 'me')).toBe(true);
  });

  it('returns unknown_msg_id (isError) for a msg_id that does not exist', async () => {
    const res = await run(ackTool, { msg_id: 'never' });
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ ok: false, error: 'unknown_msg_id' });
  });
});
