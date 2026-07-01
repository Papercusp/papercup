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
    // OMP (pi) is multi-provider and routes by REUSING the existing adapters
    // rather than owning a bespoke protocol: a Tier-1 OMP session is pinned to a
    // Claude account and egresses Anthropic-protocol traffic through the gateway
    // root, so it shares the claude/anthropic adapter (pool + upstream). This row
    // is the DIAGNOSTICS view of that delegation — the gateway dispatches by
    // request PATH (providerForGatewayRequest), never by this entry.
    // (omp-account-pinning-gateway-2026-06-29 D-003: OMP pins to Claude accounts
    // for Tier-1 parity; OpenAI-account-pinned OMP is a deliberate follow-up.)
    omp: {
      id: 'omp',
      label: 'OMP (via Claude / Anthropic)',
      protocol: 'anthropic',
      upstreamBase: opts.anthropicUpstreamBase,
      pool: opts.claudePool,
      unavailableMessage: null,
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
  /** Extra codex account ids OUTSIDE the bearer pool — the ChatGPT-subscription
   *  CLI accounts (codex-cli-bridge.ts) — so a `/v1/models` probe pinned to one
   *  still routes to the codex adapter. */
  isExtraCodexAccount?: (accountId: string) => boolean,
): GatewayProviderAdapter {
  const pathProvider = providerForGatewayPath(path, adapters);
  if (pathProvider.id === 'codex') return pathProvider;

  // Codex's OpenAI-compatible provider probes `/v1/models` before a turn. The
  // shared gateway also supports Anthropic `/v1/models`, so route by the pinned
  // account when one is present instead of globally stealing the path.
  if (path.startsWith('/v1/models')) {
    const pinnedAccount = headerValue(headers, ACCOUNT_HEADER);
    if (pinnedAccount && (adapters.codex.pool?.select(pinnedAccount) || isExtraCodexAccount?.(pinnedAccount))) {
      return adapters.codex;
    }
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
