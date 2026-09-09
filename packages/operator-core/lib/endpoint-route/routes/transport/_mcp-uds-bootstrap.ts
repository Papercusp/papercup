import { startAgentMcpServer, type AgentMcpListener } from './_mcp-uds';
import { writeEndpointIpcDiscovery } from '../../../endpoint-ipc-discovery';

/** UI startup stays independent; native MCP is advertised only after binding. */
export async function startDesktopAgentMcp(
  uiSocketPath: string,
  port: number,
): Promise<AgentMcpListener | null> {
  // Windows/WSL host boundaries and remote clients keep HTTP (plan D-009).
  if (!['linux', 'darwin'].includes(process.platform) ||
      process.env.PAPERCUSP_IPC_TCP === '1' || process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) return null;
  const host = await import('./_mcp-host');
  const listener = await startAgentMcpServer({
    port, host: {
      register: host.registerMcpHost, options: host.mcpHostServerOptions(),
      verify: host.tryBuildSpawnContext, pin: host.pinVerifiedMcpRequest,
    },
  });
  try {
    await writeEndpointIpcDiscovery(uiSocketPath, { port, agentMcp: listener.endpoint });
  } catch (error) {
    await listener.close();
    throw error;
  }
  const shutdown = () => { void listener.close().catch(() => {}); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  const close = listener.close;
  listener.close = async () => {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    await close();
  };
  // Descriptor remains as a stale generation; readers validate socket+PID.
  // Never read/modify/write a descriptor at shutdown: a replacement operator
  // may have published between the read and write, losing its advertisement.
  return listener;
}
