/**
 * Unit tests for the messages + envelope substrate.
 *
 * Pure filesystem, no PG. Uses PAPERCUSP_COORD_DIR to redirect every
 * coord/ access to a per-test temp dir.
 *
 *   npx vitest run lib/agent-tools/coordination/__tests__/messages.test.ts
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendCoordLine,
  newMsgId,
  readCoordFile,
  type CoordEnvelope,
} from '../envelope';
import { coordDir, outboxFile } from '../paths';
import {
  appendAck,
  readInbox,
  readThread,
  sendMessage,
} from '../messages';
import type { AgentIdentity } from '../identity';

function fakeIdentity(ownerId: string): AgentIdentity {
  return {
    ownerId,
    ownerLabel: ownerId,
    source: 'omp-hook-session',
    workspaceId: 'default',
    userId: null,
  };
}

let tmp = '';
let prevEnv: string | undefined;
beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'coord-msgs-'));
  prevEnv = process.env.PAPERCUSP_COORD_DIR;
  process.env.PAPERCUSP_COORD_DIR = tmp;
});
afterEach(async () => {
  if (prevEnv === undefined) delete process.env.PAPERCUSP_COORD_DIR;
  else process.env.PAPERCUSP_COORD_DIR = prevEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('paths + envelope', () => {
  it('coordDir() honours PAPERCUSP_COORD_DIR', () => {
    expect(coordDir()).toBe(tmp);
  });

  it('outboxFile() sanitises and lives under messages/', () => {
    const p = outboxFile('pus-1a2b3c4d-5e6f-7a8b');
    expect(p).toBe(join(tmp, 'messages', 'pus-1a2b3c4d-5e6f-7a8b.jsonl'));
  });

  it('newMsgId() produces unique sortable-ish ids', () => {
    const a = newMsgId();
    const b = newMsgId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });

  it('appendCoordLine + readCoordFile roundtrip; readCoordFile skips bad lines', async () => {
    const f = join(tmp, 'demo.jsonl');
    const env: CoordEnvelope = {
      ts: new Date().toISOString(),
      msg_id: 'm1',
      from: 'a',
      to: ['b'],
      kind: 'message',
      summary: 'hi',
    };
    await appendCoordLine(f, env);
    // a malformed line in the middle must not break the read
    await fs.appendFile(f, '{this is not json}\n', 'utf8');
    await appendCoordLine(f, { ...env, msg_id: 'm2', summary: 'hi again' });
    const read = await readCoordFile(f);
    expect(read.map((r) => r.msg_id)).toEqual(['m1', 'm2']);
  });

  it('readCoordFile on a missing file returns []', async () => {
    expect(await readCoordFile(join(tmp, 'missing.jsonl'))).toEqual([]);
  });
});

describe('sendMessage / readInbox', () => {
  it('one-to-one: receiver sees the message, sender does not', async () => {
    const A = fakeIdentity('A');
    const sent = await sendMessage(A, { to: ['B'], summary: 'hello B' });
    expect(sent.kind).toBe('message');
    const inboxB = await readInbox('B');
    expect(inboxB.map((m) => m.summary)).toEqual(['hello B']);
    const inboxA = await readInbox('A');
    expect(inboxA).toEqual([]); // excludeOwn = true default
  });

  it('broadcast (to:["*"]) reaches everyone except (by default) the sender', async () => {
    const A = fakeIdentity('A');
    await sendMessage(A, { to: ['*'], summary: 'all hands' });
    const inboxB = await readInbox('B');
    const inboxC = await readInbox('C');
    expect(inboxB).toHaveLength(1);
    expect(inboxC).toHaveLength(1);
    expect(await readInbox('A')).toEqual([]);
  });

  it('since_ts filters strictly later than the cutoff', async () => {
    const A = fakeIdentity('A');
    const first = await sendMessage(A, { to: ['B'], summary: 'old' });
    // Ensure the next ts is strictly later than `first.ts`.
    await new Promise((r) => setTimeout(r, 5));
    await sendMessage(A, { to: ['B'], summary: 'new' });
    const after = await readInbox('B', { since_ts: first.ts });
    expect(after.map((m) => m.summary)).toEqual(['new']);
  });

  it('kinds filter narrows by entry kind', async () => {
    const A = fakeIdentity('A');
    await sendMessage(A, { to: ['B'], summary: 'plain', kind: 'message' });
    await sendMessage(A, { to: ['B'], summary: 'notify!', kind: 'notify' });
    const onlyNotify = await readInbox('B', { kinds: ['notify'] });
    expect(onlyNotify.map((m) => m.summary)).toEqual(['notify!']);
  });

  it('missing messages dir → empty inbox', async () => {
    expect(await readInbox('B')).toEqual([]);
  });
});

describe('appendAck + readThread', () => {
  it('ack lives in the acker outbox and is reachable from the original via thread traversal', async () => {
    const A = fakeIdentity('A');
    const B = fakeIdentity('B');
    const m = await sendMessage(A, { to: ['B'], summary: 'please ack' });
    const ack = await appendAck(B, m.msg_id, A.ownerId);
    expect(ack.kind).toBe('ack');
    expect(ack.related_msg_id).toBe(m.msg_id);

    const thread = await readThread(m.msg_id);
    expect(thread.map((t) => t.msg_id)).toEqual([m.msg_id, ack.msg_id]);

    // The sender's inbox should now contain the ack.
    const inboxA = await readInbox('A');
    expect(inboxA.map((x) => x.kind)).toEqual(['ack']);
  });

  it('readThread walks chains transitively', async () => {
    const A = fakeIdentity('A');
    const B = fakeIdentity('B');
    const root = await sendMessage(A, { to: ['B'], summary: 'q' });
    const reply = await sendMessage(B, {
      to: ['A'],
      summary: 'a',
      related_msg_id: root.msg_id,
    });
    const ack = await appendAck(A, reply.msg_id, B.ownerId);
    const thread = await readThread(root.msg_id);
    expect(thread.map((t) => t.msg_id)).toEqual([
      root.msg_id,
      reply.msg_id,
      ack.msg_id,
    ]);
  });
});
