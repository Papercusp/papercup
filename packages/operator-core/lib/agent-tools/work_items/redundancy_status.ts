/**
 * work_items:redundancy_status — read a high-stakes item's redundancy config + replica ledger
 * (decentralized-dispatch-scaling P-014): the target replica count, each slot's status
 * (claimed/complete/winner/loser), owner, and judge verdict (composite + rationale). The
 * read surface for "where is this redundant item — who's running it, who won?".
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { getItemRedundancy, listReplicas, resolveReplicaHiveSlug, workItemRedundancyEnabled } from '../../work-item-redundancy';
import { activeWorkspaceId } from '../../workspace-registry';

const json = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });

export default defineTool({
  name: 'work_items:redundancy_status',
  profile: 'engineer',
  description:
    "Read a work-item's redundancy config + replica ledger: target N, each slot's status (claimed/complete/winner/loser), owner, lease expiry, and judge verdict (composite + rationale). The read view of a high-stakes item's redundant run.",
  guidance: {
    when: 'Checking how a high-stakes item is progressing across its Swarms — how many replicas have completed, whether it has been judged, and which replica won.',
    notWhen: 'A normal item (it has no replicas). The plain item state — that is work_items:get.',
    chaining: 'work_items:redundancy_status → (if ≥2 complete) work_items:judge_redundancy.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).max(120).describe('The work-item id.'),
    harness: z.string().min(1).max(80).describe('Harness the work-item lives in.'),
  }),
  async handler(args) {
    const redundancy = await getItemRedundancy(args.id, { harness: args.harness });
    if (redundancy == null) {
      return json({ ok: false, error: `work-item ${args.id} not found in harness ${args.harness}` });
    }
    const workspaceId = activeWorkspaceId();
    const hiveSlug = await resolveReplicaHiveSlug(workspaceId, args.harness);
    const replicas = await listReplicas(args.id, { harness: args.harness, workspaceId, hiveSlug });
    const completeCount = replicas.filter((r) => r.status === 'complete').length;
    return json({
      ok: true,
      id: args.id,
      harness: args.harness,
      redundancy,
      highStakes: redundancy > 1,
      active: workItemRedundancyEnabled(),
      completeCount,
      judgeable: completeCount >= 2,
      replicas: replicas.map((r) => ({
        replicaIndex: r.replicaIndex,
        owner: r.owner,
        status: r.status,
        expired: r.expired,
        expiresTs: r.expiresTs,
        judgeComposite: r.judgeComposite,
        judgeRationale: r.judgeRationale,
      })),
    });
  },
});
