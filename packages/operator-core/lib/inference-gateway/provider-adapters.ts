import type { AccountPool } from './gateway';

export type GatewayProviderId = 'claude' | 'codex' | 'omp';
export type GatewayProviderProtocol = 'anthropic' | 'openai-compatible' | 'unsupported';

export interface GatewayProviderAdapter {
  id: GatewayProviderId;
  label: string;
  protocol: GatewayProviderProtocol;
  upstreamBase: string | null;
  pool: AccountPool | null;
  unavailableMessage: string | null;
}

export interface GatewayProviderAdapters {
  claude: GatewayProviderAdapter;
  codex: GatewayProviderAdapter;
  omp: GatewayProviderAdapter;
}

export interface GatewayProviderStatus {
  id: GatewayProviderId;
  label: string;
  protocol: GatewayProviderProtocol;
  configured: boolean;
  upstreamBase: string | null;
  unavailableMessage: string | null;
}

type GatewayRequestHeaders = Record<string, string | string[] | undefined>;

const ACCOUNT_HEADER = 'x-papercusp-account';

export function makeGatewayProviderAdapters(opts: {
  claudePool: AccountPool;
  codexPool?: AccountPool | null;
  anthropicUpstreamBase: string;
  openaiUpstreamBase: string;
}): GatewayProviderAdapters {
  return {
    claude: {
      id: 'claude',
      label: 'Claude / Anthropic',
      protocol: 'anthropic',
      upstreamBase: opts.anthropicUpstreamBase,
      pool: opts.claudePool,
      unavailableMessage: null,
    },
    codex: {
      id: 'codex',
      label: 'Codex / OpenAI-compatible',
      protocol: 'openai-compatible',
      upstreamBase: opts.openaiUpstreamBase,
      pool: opts.codexPool ?? null,
      unavailableMessage: 'inference-gateway: no Codex account pool configured',
    },
    omp: {
      id: 'omp',
      label: 'OMP provider',
      protocol: 'unsupported',
      upstreamBase: null,
      pool: null,
      unavailableMessage: 'inference-gateway: OMP provider gateway adapter is not implemented yet',
    },
  };
}

export function providerForGatewayPath(path: string, adapters: GatewayProviderAdapters): GatewayProviderAdapter {
  return path.startsWith('/v1/responses') ? adapters.codex : adapters.claude;
}

function headerValue(headers: GatewayRequestHeaders, name: string): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0]?.trim() || null;
  return raw?.trim() || null;
}

export function providerForGatewayRequest(
  path: string,
  headers: GatewayRequestHeaders,
  adapters: GatewayProviderAdapters,
): GatewayProviderAdapter {
  const pathProvider = providerForGatewayPath(path, adapters);
  if (pathProvider.id === 'codex') return pathProvider;

  // Codex's OpenAI-compatible provider probes `/v1/models` before a turn. The
  // shared gateway also supports Anthropic `/v1/models`, so route by the pinned
  // account when one is present instead of globally stealing the path.
  if (path.startsWith('/v1/models')) {
    const pinnedAccount = headerValue(headers, ACCOUNT_HEADER);
    if (pinnedAccount && adapters.codex.pool?.select(pinnedAccount)) return adapters.codex;
  }

  return pathProvider;
}

export function gatewayProviderStatuses(adapters: GatewayProviderAdapters): GatewayProviderStatus[] {
  return (['claude', 'codex', 'omp'] as const).map((id) => {
    const adapter = adapters[id];
    return {
      id: adapter.id,
      label: adapter.label,
      protocol: adapter.protocol,
      configured: adapter.pool !== null && adapter.upstreamBase !== null,
      upstreamBase: adapter.upstreamBase,
      unavailableMessage: adapter.unavailableMessage,
    };
  });
}
