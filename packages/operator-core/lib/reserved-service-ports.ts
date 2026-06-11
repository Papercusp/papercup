/**
 * Ports owned by long-lived core services. An opportunistic port-walk (the
 * voice WS servers' EADDRINUSE fallback) must NEVER squat one: 2026-06-10 the
 * staging host's mobile-voice walk (base 3068) stepped onto :3070 during the
 * release deploy's stop window, so the GREEN operator crash-looped on
 * EADDRINUSE and the fleet's MCP surface answered 426 (a WS server speaking
 * to plain-HTTP clients) until the squatter was found.
 */
export const RESERVED_SERVICE_PORTS: ReadonlySet<number> = new Set([
  3055, // Vite SPA dev server
  3070, // GREEN operator (release checkout)
  3170, // staging operator (integration tree)
]);

export function isReservedServicePort(port: number): boolean {
  return RESERVED_SERVICE_PORTS.has(port);
}
