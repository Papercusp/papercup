import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { papercuspHome } from '@papercusp/host-platform/home';

interface AcpOwner { id: number; workspaceId: string; coordOwnerId: string | null }

function directory(owner: AcpOwner) {
  const key = createHash('sha256').update(JSON.stringify([owner.workspaceId, owner.id, owner.coordOwnerId])).digest('hex');
  return join(papercuspHome(), 'acp-wakes', key);
}

export async function enqueueAcpWake(owner: AcpOwner, id: number, text: string) {
  const dir = directory(owner);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, randomUUID() + '.tmp');
  try {
    await writeFile(tmp, text, { flag:'wx', mode:0o600, flush:true });
    try { await link(tmp, join(dir, id + '.wake')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await unlink(tmp).catch(() => {}); }
}

export async function acpWakeSnapshot(owner: AcpOwner, acknowledged: number[]) {
  const dir = directory(owner);
  let names;
  try { names = new Set(await readdir(dir)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !acknowledged.length) return [];
    throw error;
  }
  for (const id of acknowledged) {
    if (!names.has(id + '.wake')) throw new Error('Unknown ACP wake receipt');
    await writeFile(join(dir, id + '.ack'), '', {mode:0o600,flush:true});
    names.add(id + '.ack');
  }
  const ids = [...names].filter(name => /^\d+\.wake$/.test(name)).map(name => Number(name.split('.')[0]))
    .filter(id => !names.has(id + '.ack')).sort((a,b) => a-b).slice(0,64);
  return Promise.all(ids.map(async id => ({id, text:await readFile(join(dir,id + '.wake'),'utf8')})));
}
