import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { papercuspHome } from '@papercusp/host-platform/home';
import type { MemberLaunchOpts } from './agent-launch-core';
import { getLatestActiveAdvSessionByOwner } from './adv-sessions';
import type { SpawnConsoleResult } from './console-spawn';

export async function acpControl(parent: NonNullable<Awaited<ReturnType<typeof getLatestActiveAdvSessionByOwner>>>,
  route: 'member' | 'carry' | 'probe', payload: Record<string,unknown>) {
    const key = createHash('sha256').update(JSON.stringify([parent.workspaceId,parent.id,parent.coordOwnerId,parent.sessionId])).digest('hex');
    const socketPath = join('/tmp','psu-acp-'+process.getuid!(),key+'.sock');
    const token = (await readFile(join(papercuspHome(),'superuser-token'),'utf8')).trim();
    const body = JSON.stringify({...payload,id:randomUUID(),issued:Date.now(),owner:parent.coordOwnerId,native:parent.sessionId});
    const signature = createHmac('sha256',token).update(body).digest('hex');
    return new Promise<string>((resolve,reject) => {
      const req = request({socketPath,path:'/'+route,method:'POST',headers:{'x-psu-signature':signature}}, res => {
        let reply = '';
        res.setEncoding('utf8');
        res.on('data',chunk => { if (reply.length < 4096) reply += chunk; });
        res.on('end',() => res.statusCode === 201 ? resolve(reply) : reject(new Error('Owner declined member launch: '+reply)));
        res.on('error',reject);
      });
      req.setTimeout(30000,() => req.destroy(new Error('ACP owner timed out admitting the member')));
      req.on('error',reject);
      req.end(body);
    });
}

/** Called inside the existing governor reservation, immediately before headless spawn. */
export async function spawnAcpMember(workspace: string, owner: string, label: string,
  spec: MemberLaunchOpts, admission: unknown, ordinary: () => Promise<SpawnConsoleResult>): Promise<SpawnConsoleResult> {
  const parent = await getLatestActiveAdvSessionByOwner(owner,workspace);
  if (parent?.launchArgv?.[0] !== 'psu-acp') return ordinary();
  try {
    if (spec.agent !== 'claude' || !parent.sessionId) throw new Error('ACP fleets require a registered Claude session');
    await acpControl(parent,'member',{label,spec,admission});
    return {status:'ok',pid:null,terminal:label,child:null,display:null,desktopEnvResolvedVia:null};
  } catch (error) {
    return {status:'error',code:503,error:error instanceof Error ? error.message : String(error)};
  }
}
