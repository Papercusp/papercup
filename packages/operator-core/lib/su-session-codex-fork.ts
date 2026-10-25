/** Native history is the only state copied into a new tracked Codex runtime.
 * Claims, callbacks, commands and wake registrations stay with the parent. */
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CodexNativeSessionHandle } from './native-session-handles';
import { findCodexRolloutPathByUuid } from './session-transcript-resolvers';
import type { RpcFrame, SuStdioPeer } from './su-session-stdio-peer';

function record(value: unknown): RpcFrame {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RpcFrame : {};
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function forkCodexNativeHistory(input: {
  peer: Pick<SuStdioPeer, 'request'>;
  source: CodexNativeSessionHandle;
  childOwnerId: string;
  childHome: string;
  params: RpcFrame;
}): Promise<RpcFrame> {
  const { source, peer } = input;
  if (!source.ownerId || source.ownerId === input.childOwnerId || !source.rolloutId
    || !source.exactResumeSupported) throw new Error('Codex fork requires a distinct tracked parent identity');
  const [sourceHome, childHome] = await Promise.all([realpath(source.codexHome), realpath(input.childHome)]);
  if (sourceHome === childHome) throw new Error('Codex fork requires a fresh child home');
  const sourcePath = await findCodexRolloutPathByUuid(source.rolloutId, { homeOverride: source.codexHome });
  if (!sourcePath || !inside(sourceHome, await realpath(sourcePath)) || !(await lstat(sourcePath)).isFile()) {
    throw new Error('Codex fork parent history is unavailable');
  }
  // Seed one native history file, never the parent's config, database or locks.
  // The native fork owns parsing and writes its result under the child's home.
  const sourceSessions = join(sourceHome, 'sessions');
  const sourceFile = await realpath(sourcePath);
  if (!inside(sourceSessions, sourceFile)) throw new Error('Codex fork parent is outside its native history');
  const seed = join(childHome, 'sessions', relative(sourceSessions, sourceFile));
  await mkdir(dirname(seed), { recursive: true });
  if (resolve(await realpath(dirname(seed))) !== resolve(dirname(seed))) {
    throw new Error('Codex fork seed directory must not redirect outside the child home');
  }
  await copyFile(sourcePath, seed, constants.COPYFILE_EXCL);
  try {
    const read = await peer.request({ method: 'thread/read', params: { threadId: source.rolloutId, includeTurns: true } });
    const parent = record(read.thread);
    if (parent.id !== source.rolloutId || !Array.isArray(parent.turns)) throw new Error('Codex fork could not verify parent history');
    const turns = parent.turns.map(record);
    let boundary = turns.filter(turn => turn.status === 'completed' && typeof turn.id === 'string').at(-1);
    if (!boundary && parent.historyMode === 'paginated') {
      const page = await peer.request({ method: 'thread/turns/list', params: {
        threadId: source.rolloutId, sortDirection: 'desc', limit: 100, itemsView: 'summary',
      } });
      boundary = (Array.isArray(page.data) ? page.data.map(record) : [])
        .find(turn => turn.status === 'completed' && typeof turn.id === 'string');
    }
    // An empty or entirely pending history has no safe inclusive boundary.
    if (!boundary) throw new Error(`Codex fork has no completed parent turn boundary (mode=${String(parent.historyMode)}, turns=${turns.length}, statuses=${turns.map(turn => String(turn.status)).join(',')})`);
    const result = await peer.request({ method: 'thread/fork', params: {
      ...input.params, threadId: source.rolloutId, ephemeral: false,
      ...(boundary ? { lastTurnId: boundary.id } : {}),
    } });
    const child = record(result.thread);
    if (typeof child.id !== 'string' || !child.id || child.id === source.rolloutId
      || child.forkedFromId != null && child.forkedFromId !== source.rolloutId
      || typeof child.path !== 'string' || !inside(childHome, await realpath(child.path))) {
      throw new Error('Codex fork did not return an independently persisted child identity');
    }
    return result;
  } finally {
    await unlink(seed);
  }
}
