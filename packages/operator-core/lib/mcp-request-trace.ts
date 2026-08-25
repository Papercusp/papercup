/** Shared, bounded correlation contract for the local MCP proxy → operator hop. */
import { headersFromExtra } from '@papercusp/tooldef-mcp';

export const MCP_REQUEST_TRACE_HEADER = 'x-papercusp-mcp-trace-id';
export const MAX_MCP_REQUEST_TRACE_ID_CHARS = 36;

/** Accept only the fixed UUID shape minted by the proxy; reject arbitrary client input. */
export function mcpTraceIdFromExtra(extra: unknown): string | null {
  const value = headersFromExtra(extra).get(MCP_REQUEST_TRACE_HEADER)?.trim() ?? '';
  if (value.length > MAX_MCP_REQUEST_TRACE_ID_CHARS) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}
