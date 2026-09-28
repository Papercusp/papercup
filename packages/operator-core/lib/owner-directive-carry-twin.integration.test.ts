/**
 * WI-10003691: a carry-respawn re-delivers an OPEN owner message to the successor
 * as its first prompt. The successor runs under a NEW native session id, so the
 * hook's capture keyed it on a new source_turn_ref and minted a second directive
 * for one owner message (#806 → #816). recordOwnerDirective now returns the OPEN
 * twin from the same agent lineage instead; a closed twin, another lineage, or
 * the same session keep their existing behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  dispositionOwnerDirective,
  listRecentlyClosedDirectives,
  recordOwnerDirective,
} from './owner-directives';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('owner-directive carry twin (WI-10003691)', () => {
  let db: OrgTestDb;
  const workspaceId = 'owner-directive-carry-twin-ws';

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup?.();
  });

  function capture(args: { session: string; text: string; recordedBy?: string; turn?: string }) {
    return recordOwnerDirective(
      {
        workspaceId,
        sessionRef: args.session,
        sourceTurnRef: `${args.session}:${args.turn ?? args.text}`,
        verbatimText: args.text,
        recordedBy: args.recordedBy ?? 'su-lineage-a',
        capturedByHook: true,
      },
      db.adminSql,
    );
  }

  it('a re-delivery into a successor session returns the OPEN original, not a twin', async () => {
    const original = await capture({ session: 'native-1', text: 'regarding tesla, any advancements?' });
    const redelivered = await capture({ session: 'native-2', text: 'regarding tesla, any advancements?' });
    expect(redelivered.id).toBe(original.id);
  });

  it('CONTROL: once the original is CLOSED, the same text is a new order and mints', async () => {
    const original = await capture({ session: 'native-3', text: 'publish it now' });
    await dispositionOwnerDirective(
      { id: original.id, status: 'done', note: 'published', dispositionedBy: 'su-lineage-a' },
      db.adminSql,
    );
    const again = await capture({ session: 'native-4', text: 'publish it now' });
    expect(again.id).not.toBe(original.id);
  });

  it('CONTROL: the same text pasted into ANOTHER agent’s session is that agent’s own directive', async () => {
    const mine = await capture({ session: 'native-5', text: 'status report please' });
    const theirs = await capture({ session: 'native-6', text: 'status report please', recordedBy: 'su-lineage-b' });
    expect(theirs.id).not.toBe(mine.id);
  });

  it('CONTROL: the same session typing the text twice still keys on its own turn refs', async () => {
    const first = await capture({ session: 'native-7', text: 'continue', turn: 't1' });
    const second = await capture({ session: 'native-7', text: 'continue', turn: 't2' });
    expect(second.id).not.toBe(first.id);
  });

  it('listRecentlyClosedDirectives returns this lineage’s closed captures with their capture time', async () => {
    const row = await capture({ session: 'native-8', text: 'close me' });
    await dispositionOwnerDirective(
      { id: row.id, status: 'declined', note: 'not needed', dispositionedBy: 'su-lineage-a' },
      db.adminSql,
    );
    const closed = await listRecentlyClosedDirectives({ workspaceId, recordedBy: 'su-lineage-a' }, db.adminSql);
    const hit = closed.find((d) => d.id === row.id);
    expect(hit?.text).toBe('close me');
    expect(Number.isFinite(hit?.createdAtMs)).toBe(true);
    const other = await listRecentlyClosedDirectives({ workspaceId, recordedBy: 'su-lineage-b' }, db.adminSql);
    expect(other.some((d) => d.id === row.id)).toBe(false);
  });
});
