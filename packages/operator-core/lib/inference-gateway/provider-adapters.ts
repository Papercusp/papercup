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
