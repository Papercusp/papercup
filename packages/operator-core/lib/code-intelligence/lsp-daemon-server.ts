/** Owns language-server processes and adapter state outside the operator process. */
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listenUnixSocketExclusive, SIDECAR_EXIT_SOCKET_IN_USE } from '../sidecar-socket/pid-keyed-socket.ts';
import { resolveLspDaemonSocketPath, reapOrphanedLspDaemonSockets } from './lsp-daemon-socket.ts';
import { resolveLspDaemonDispatchContext, type LspDaemonRequest } from './lsp-daemon-protocol.ts';
import { runLspAdmission } from './lsp-admission.ts';
import { lspDaemonFacade } from './lsp-facade.ts';
import { activeWorkspaceId } from '../workspace-registry.ts';
import type { CodeIntelAnswer } from './contracts.ts';

interface RpcRequest { jsonrpc: '2.0'; id: string; method: 'lsp:query' | 'lsp:cancel'; params: LspDaemonRequest | { requestId: string } }

export async function dispatchLspDaemonRequest(
  request: LspDaemonRequest,
  requestId: string,
  signal: AbortSignal,
): Promise<CodeIntelAnswer> {
  const context = resolveLspDaemonDispatchContext(request, signal);
  // The local facade owns the original exact refusals and the flag check. An
  // incomplete request never reaches admission or an adapter child.
  if (!context) return lspDaemonFacade(request.op, request.args);
  return runLspAdmission({
    workspaceId: request.workspaceId ?? activeWorkspaceId(),
    requestId,
    language: context.language,
    projectRoot: context.projectRoot,
    op: request.op,
    actor: request.actorId,
    priority: request.priority,
    deadlineAtMs: request.deadlineAtMs ?? Date.now() + 90_000,
    signal,
    queryKey: request.args.file ?? request.args.name,
  }, () => lspDaemonFacade(request.op, request.args));
}

/** Start once per host; all cluster workers address the primary's pinned socket. */
export function runLspDaemonServer(
  execute: typeof dispatchLspDaemonRequest = dispatchLspDaemonRequest,
): Server {
  const socketPath = resolveLspDaemonSocketPath();
  mkdirSync(dirname(socketPath), { recursive: true });
  reapOrphanedLspDaemonSockets();
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    const controllers = new Map<string, AbortController>();
    let buffer = '';
    const send = (value: unknown) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_048_576) { socket.destroy(); return; }
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let frame: RpcRequest;
        try { frame = JSON.parse(line) as RpcRequest; }
        catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
        if (frame.jsonrpc !== '2.0' || typeof frame.id !== 'string') {
          send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); continue;
        }
        if (frame.method === 'lsp:cancel') {
          const target = (frame.params as { requestId?: string })?.requestId;
          if (target) controllers.get(target)?.abort();
          send({ jsonrpc: '2.0', id: frame.id, result: { cancelled: Boolean(target && controllers.has(target)) } });
          continue;
        }
        if (frame.method !== 'lsp:query' || !frame.params || typeof (frame.params as LspDaemonRequest).op !== 'string') {
          send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported LSP method' } }); continue;
        }
        if (controllers.has(frame.id)) {
          send({ jsonrpc: '2.0', id: frame.id, error: { code: -32600, message: 'Duplicate request id' } }); continue;
        }
        const controller = new AbortController();
        controllers.set(frame.id, controller);
        void execute(frame.params as LspDaemonRequest, frame.id, controller.signal).then(
          (result) => send({ jsonrpc: '2.0', id: frame.id, result }),
          (error) => send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }),
        ).finally(() => controllers.delete(frame.id));
      }
    });
    socket.once('close', () => { clients.delete(socket); for (const controller of controllers.values()) controller.abort(); });
  });
  const cleanup = () => { for (const client of clients) client.destroy(); server.close(); };
  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);
  let ownsSocket = false;
  const unlinkOwnedSocket = () => { if (ownsSocket && existsSync(socketPath)) { try { unlinkSync(socketPath); } catch { /* stale socket reaped next start */ } } };
  process.once('exit', unlinkOwnedSocket);
  server.once('close', () => {
    process.off('SIGTERM', cleanup);
    process.off('SIGINT', cleanup);
    process.off('exit', unlinkOwnedSocket);
    unlinkOwnedSocket();
  });
  void listenUnixSocketExclusive(server, socketPath).then((state) => {
    if (state === 'in-use') process.exitCode = SIDECAR_EXIT_SOCKET_IN_USE;
    else { ownsSocket = true; process.stdout.write(`PAPERCUSP_LSP_DAEMON_READY ${randomUUID()}\n`); }
  }, (error) => { console.error('[lsp-daemon] socket bind failed', error); process.exitCode = 1; });
  return server;
}
