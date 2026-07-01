/**
 * hive:ask — initiate a cross-Hive ASK to a peer Hive
 * (hive-network-surface-2026-06-11 P-003, brief B-04). The initiating side of the
 * sovereignty boundary: THIS Hive addresses a peer Hive (by pubkey, from
 * discovery:hives), the envelope lands at the peer's boundary and — if the peer
 * has granted us `ask` — becomes a conversation in THEIR substrate. The peer's
 * answer comes back asynchronously through our boot-wired boundary and is
 * recorded in the C-1 ledger; await it on the returned `answeredEvent` key.
 *
 * Use for a QUESTION the peer Hive is the authority on (it owns the domain) — not
 * to hand them work (that is hive:request_work). Dedupe via discovery:hives /
 * hive:asks first.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText } from '../limits';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { sendCrossHiveAsk } from '../../cross-hive-ask-send';
import { productionSendCrossHiveAskDeps } from './_cross-hive-ask-deps';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'hive:ask',
  profile: 'engineer',
  description:
    "Initiate a cross-Hive ASK to a peer Hive (by pubkey): a question the peer Hive owns the answer to. The envelope is signed, sent store-and-forward, and recorded in this Hive's ask ledger; the peer's answer arrives asynchronously — events:await the returned answeredEvent key. Requires an outbound grant to the peer.",
  guidance: {
    when: 'The Queen/owner needs an answer another Hive is the authority on (it owns that domain). Find the peer via discovery:hives, then hive:ask, then events:await the returned answeredEvent.',
    notWhen:
      'Handing the peer WORK to do (use hive:request_work). Within-Hive questions (coord:ask / conversations). Granting a peer to send asks INTO this Hive (that is the inbound hive:cross_grant).',
    chaining:
      'discovery:hives (find the peer Hive pubkey) → hive:ask { hive, peerHivePubkey, subject, body } → events:await { event: <answeredEvent> }. Review outstanding asks with hive:asks.',
    seeAlso: [
      'hive:asks (review outstanding asks + their replies)',
      'discovery:hives (find the peer Hive to ask)',
      'hive:request_work (ask a peer to DO work, not answer a question)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z.string().min(1).max(120).describe("THIS Hive's home slug — the asking Hive (signer + boundary are scoped to it)."),
    peerHivePubkey: z.string().min(1).max(400).describe('The peer Hive\'s pubkey (from discovery:hives) to address the ask to.'),
    subject: z.string().min(1).max(200).describe('A short subject line for the ask.'),
    body: hardText(8000).describe('The question body.'),
    workspace: z.string().max(120).optional(),
    askedBy: z.string().max(200).optional().describe('Your coord ownerId (su-…). When supplied, the C-4 reply event fires with `to:[askedBy]` so you are woken on the answer rather than polling.'),
  }),
  async handler(args) {
    const ws = args.workspace ?? activeWorkspaceId();
    const result = await sendCrossHiveAsk(
      { workspaceId: ws, hiveSlug: args.hive, peerPubkey: args.peerHivePubkey, kind: 'ask', subject: args.subject, body: args.body, askedBy: args.askedBy },
      productionSendCrossHiveAskDeps(),
    );
    return json(result);
  },
});
