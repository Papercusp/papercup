/**
 * Resolve the installed MCP template before a native client reads it.
 * Self-contained so the standalone recovery hook can embed this same resolver.
 */
export function resolveClaudeMcpEntry(entry, env = process.env) {
  if (!entry || typeof entry.url !== "string") return entry;
  const expand = (value) => {
    const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name, fallback) => {
      const current = env[name];
      if ((current === undefined || current === "") && fallback !== undefined) return fallback;
      if (current === undefined) throw new Error("Missing Claude MCP environment variable: " + name);
      return String(current);
    });
    if (resolved.includes("$" + "{")) throw new Error("Unresolved Claude MCP configuration template");
    return resolved;
  };
  // Resolve query values individually so an identity containing &, + or # is
  // preserved as one value, rather than becoming URL syntax.
  const query = entry.url.indexOf("?");
  const url = new URL(query < 0
    ? expand(entry.url)
    : expand(entry.url.slice(0, query)) + entry.url.slice(query));
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Claude MCP endpoint must use HTTP or HTTPS");
  }
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) params.append(expand(key), expand(value));
  url.search = params.toString();
  const headers = entry.headers && Object.fromEntries(
    Object.entries(entry.headers).map(([key, value]) => [key, expand(value)]),
  );
  return { ...entry, url: url.href, ...(headers ? { headers } : {}) };
}
