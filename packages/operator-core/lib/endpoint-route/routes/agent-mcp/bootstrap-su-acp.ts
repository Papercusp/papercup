import { defineTool } from '@papercusp/agent-mcp';
import { getAdvSessionInWorkspace } from '../../../adv-sessions';
import { acpWakeSnapshot } from '../../../su-session-acp-wakes';
import { hasPendingDeliberateWakeDelivery, listParkedAwaitsForSubscribers } from '../../../events/await/store';
import { readActiveLoopFacts } from '../../../harness/routines/loop';
import { principalFromSuperuserToken } from '../../../auth/principal/from-superuser-token';
import { jsonRes } from './bootstrap-su-shared';

export const acpCensus = defineTool({
  method:'POST', path:'/agent-mcp/console/bootstrap-su/acp-census', auth:'loopback',
  async handler(req) {
    if (!await principalFromSuperuserToken(req.headers)) return jsonRes({error:'Local operator credential required'},403);
    const p = await req.json().catch(() => null);
    if (!p || !Number.isSafeInteger(p.adv) || typeof p.workspace !== 'string' || !Array.isArray(p.ack)
      || p.ack.length > 64 || p.ack.some((x: unknown) => typeof x !== 'number' || !Number.isSafeInteger(x) || x < 1)) {
      return jsonRes({error:'Invalid ACP census request'},400);
    }
    const row = await getAdvSessionInWorkspace(p.adv,p.workspace);
    if (!row || row.retiredAt || row.endedAt || row.launchArgv?.[0] !== 'psu-acp' || row.coordOwnerId !== p.owner
      || !row.coordOwnerId || !row.sessionId || row.sessionId !== p.native) return jsonRes({error:'ACP session binding changed'},409);
    try {
      const [awaits,queued,loop] = await Promise.all([listParkedAwaitsForSubscribers([row.coordOwnerId]),
        hasPendingDeliberateWakeDelivery(row.coordOwnerId), readActiveLoopFacts(row.coordOwnerId)]);
      const wakes = await acpWakeSnapshot(row,p.ack);
      return jsonRes({ok:true,waiting:awaits.length > 0 || queued || !!loop?.active,wakes});
    } catch {
      return jsonRes({error:'ACP wake census is unavailable'},503);
    }
  }
});
