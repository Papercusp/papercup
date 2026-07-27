/**
 * P-006 live check (unread-count-truthfulness-2026-07-27).
 *
 * Runs the REAL getAgentCoordState against the live operator DB for several
 * live agents and prints, per agent:
 *   pre-phase1  — no cursor at all (the 19k bug)
 *   pre-phase2  — cursor applied, but counting everything shown-or-not
 *   now         — the shipped rule (cursor + D-006 visibility)
 * A unit test cannot tell you the rendered number changed; this can.
 */
import { coordLog, refreshCoordPerWorkspace, coordWorkspaceId } from '../packages/operator-core/lib/agent-tools/coordination/log';
import { readAckedMsgIds } from '../packages/operator-core/lib/agent-tools/coordination/messages';
import { readWatermark } from '../packages/operator-core/lib/agent-tools/coordination/watermarks';
import { pickUnreadCursor } from '../packages/operator-core/lib/agent-tools/coordination/watermarks';
import { lastInboxReadAtBatch } from '../packages/operator-core/lib/agent-tools/coordination/inbox-read-freshness';
import { getAgentCoordState } from '../packages/operator-core/lib/adv-agent-detail';
import { isAmbientBroadcast } from '../packages/operator-core/lib/agent-tools/coordination/inbox-visibility';
import type { CoordEnvelope } from '@papercusp/coordination/core';

const recipientsOf = (e: { to?: unknown }): string[] => (Array.isArray(e.to) ? (e.to as string[]) : []);

async function main() {
  const owners = process.argv.slice(2);
  if (owners.length === 0) throw new Error('pass one or more ownerIds');

  // The coord log is workspace-partitioned behind a flag whose sync cache is
  // unloaded at module init — without this a standalone script silently reads
  // the legacy 'default' partition (33 rows) instead of the live one.
  await refreshCoordPerWorkspace();
  const messages = (await coordLog.readLines('messages')) as CoordEnvelope[];
  console.log(`coord workspace: ${coordWorkspaceId()}`);
  console.log(`live message rows: ${messages.length}\n`);
  if (messages.length < 1000) throw new Error(`only ${messages.length} rows — wrong partition, not the live log`);

  for (const owner of owners) {
    const [acked, wm, lastRead] = await Promise.all([
      readAckedMsgIds(owner),
      readWatermark(owner),
      lastInboxReadAtBatch([owner]),
    ]);
    const cursor = pickUnreadCursor(
      pickUnreadCursor(wm?.messages_since_ts, wm?.messages_shown_ts),
      lastRead.get(owner) ?? null,
    );

    const base = (m: CoordEnvelope) =>
      m.kind === 'message' &&
      m.from !== owner &&
      (recipientsOf(m).includes(owner) || recipientsOf(m).includes('*')) &&
      !acked.has(m.msg_id);

    const prePhase1 = messages.filter(base).length;
    const afterCursor = messages.filter((m) => base(m) && (!cursor || m.ts > cursor));
    const prePhase2 = afterCursor.length;

    const state = await getAgentCoordState(owner); // the SHIPPED path
    const intents = afterCursor.filter(
      (m) => (m as Record<string, unknown>)['lifecycle'] === 'intent' && (m as Record<string, unknown>)['auto'] === true,
    ).length;
    const ambient = afterCursor.filter((m) => isAmbientBroadcast(m as unknown as Record<string, unknown>)).length;

    console.log(`${owner}`);
    console.log(`  cursor           : ${cursor ?? '(none on record)'}`);
    console.log(`  pre-phase1 (none): ${prePhase1}`);
    console.log(`  pre-phase2 (cursor only): ${prePhase2}`);
    console.log(`  NOW (shipped)    : ${state.unreadCount}`);
    console.log(`    of which excluded — intent-declares: ${intents}, ambient: ${ambient}, coalesced/retracted: ${prePhase2 - intents - ambient - state.unreadCount}`);
    console.log('');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
