/** Resolve only an HTTP MCP entry's URL and headers; preserve its other fields. */
export function resolveClaudeMcpEntry<T extends {
  url?: string;
  headers?: Record<string, string>;
}>(entry: T, env?: Record<string, string | undefined>): T;
