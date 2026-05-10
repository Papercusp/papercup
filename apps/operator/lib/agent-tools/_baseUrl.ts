/**
 * Operator-local base URL for in-process tools that call the operator's
 * own HTTP routes. Mirrors the registry-def helper in
 * apps/operator/lib/commands/defs/* — same priority + fallbacks.
 *
 * Server-side only (MCP tools run in the Node runtime).
 */
export function operatorBaseUrl(): string {
  // Allow explicit override (CI, multi-instance setups).
  if (process.env.PAPERCUSP_OPERATOR_BASE) return process.env.PAPERCUSP_OPERATOR_BASE;
  // Otherwise resolve via PORT (the running server's port).
  const port = process.env.PORT ?? process.env.NEXT_PUBLIC_PORT ?? '3070';
  return `http://127.0.0.1:${port}`;
}
