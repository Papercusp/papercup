import { listListeningSockets, type ListeningSocket } from './listening-sockets';
import type { ClusterBootFailureEvidence } from './cluster-fork';

type PortOwner = Pick<ListeningSocket, 'port' | 'pid' | 'pids' | 'command' | 'ownerVisible'>;
type ListeningPortReader = (options: { port: number; limit: number }) => Promise<{ sockets: readonly PortOwner[] }>;

const PORT_LOOKUP_BUDGET_MS = 1_000;

async function readPortWithinBudget(
  readListeningPort: ListeningPortReader,
  port: number,
  budgetMs: number,
): Promise<{ sockets: readonly PortOwner[] }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readListeningPort({ port, limit: 16 }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`listener lookup exceeded ${budgetMs}ms`)), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describePortOwners(port: number, sockets: readonly PortOwner[]): string {
  const matching = sockets.filter((socket) => socket.port === port);
  if (!matching.length) {
    return `EADDRINUSE was reported on port ${port}, but no listener remained when the supervisor checked`;
  }

  const owners = new Set<string>();
  for (const socket of matching) {
    const pids = socket.pids.length ? socket.pids : socket.pid == null ? [] : [socket.pid];
    if (!socket.ownerVisible) continue;
    for (const pid of pids) owners.add(`pid ${pid} (${socket.command ?? 'unknown command'})`);
  }
  if (owners.size) {
    const hidden = matching.some((socket) => !socket.ownerVisible);
    return `port ${port} already in use by ${[...owners].join(', ')}${hidden ? '; another listener owner is hidden' : ''}`;
  }
  return `port ${port} is already in use, but its listener owner is not visible to this user`;
}

/**
 * Resolve structured EADDRINUSE evidence to the listener currently holding the
 * port. Reuses the operator's canonical ss-based reader and preserves its
 * same-uid visibility contract; a hidden owner is never reported as an empty port.
 */
export async function describeClusterStartupFailures(
  failures: readonly ClusterBootFailureEvidence[],
  readListeningPort: ListeningPortReader = listListeningSockets,
): Promise<string[]> {
  const ports = [...new Set(failures.filter((failure) => failure.code === 'EADDRINUSE').map((failure) => failure.port))];
  return Promise.all(ports.map(async (port) => {
    try {
      const result = await readPortWithinBudget(readListeningPort, port, PORT_LOOKUP_BUDGET_MS);
      return describePortOwners(port, result.sockets);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
      return `EADDRINUSE was reported on port ${port}, but listener-owner lookup failed (${reason})`;
    }
  }));
}
