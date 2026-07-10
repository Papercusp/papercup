import type { AccountPool } from './gateway';
import { CODEX_ORIGINATOR, CODEX_OPENAI_BETA } from './codex-oauth-proxy';

export type GatewayProviderId = 'claude' | 'codex' | 'omp';
export type GatewayProviderProtocol = 'anthropic' | 'openai-compatible' | 'unsupported';

export interface GatewayProviderAdapter {
  id: GatewayProviderId;
  label: string;
  protocol: GatewayProviderProtocol;
  upstreamBase: string | null;
  pool: AccountPool | null;
  /** Live count of accounts served OUTSIDE the bearer `pool` — the codex CLI-bridge
   *  (ChatGPT-subscription) accounts (codex-cli-bridge.ts). A getter, not a snapshot,
   *  so a pool hot-reload applies to the next diagnostics read. Counted toward
   *  `configured` in gatewayProviderStatuses (WI-3068: an all-CLI codex deployment has
   *  `pool: null` BY DESIGN and used to read as "not configured"). */
  cliAccountCount?: () => number;
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
  /** Out-of-pool CLI-bridge accounts currently serving this provider (codex ChatGPT-subscription). */
  cliAccountCount: number;
  upstreamBase: string | null;
  unavailableMessage: string | null;
}

type GatewayRequestHeaders = Record<string, string | string[] | undefined>;

const ACCOUNT_HEADER = 'x-papercusp-account';

export function makeGatewayProviderAdapters(opts: {
  claudePool: AccountPool;
  codexPool?: AccountPool | null;
  /** Live count of codex CLI-bridge accounts served OUTSIDE the bearer pool (WI-3068). */
  codexCliAccountCount?: () => number;
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
      cliAccountCount: opts.codexCliAccountCount,
      // FALLBACK text for a request that finds no serving account at request time (bearer
      // pool absent AND the CLI-bridge list empty). Whether codex is ACTUALLY unavailable is
      // decided per-read in gatewayProviderStatuses — a bearer-pool-less gateway whose codex
      // accounts are all CLI-bridge is fully configured (WI-3068 false negative).
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
    if (pinnedAccount && (adapters.codex.pool?.select?.(pinnedAccount) || isExtraCodexAccount?.(pinnedAccount))) {
      return adapters.codex;
    }
    // WI-3651: an UNPINNED codex request (WI-3645 auto-routing, no x-papercusp-account) still
    // self-identifies via the headers the codex CLI stamps on every request (codex-oauth-proxy.ts:
    // `originator: codex_cli_rs`, `OpenAI-Beta: responses=experimental`). Without this, an unpinned
    // `/v1/models` probe fell through to the Claude adapter, which answers with Claude's catalog
    // shape ({ data: [{ id: 'claude-...' }] }) -- missing the `models` field codex expects -- so
    // codex logged a noisy "failed to refresh available models" ERROR once per auto session and
    // fell back to its baked-in model list. Pure header sniffing, no pool lookup: cheap, and safe
    // even for an all-CLI codex deployment (no bearer pool at all).
    const originator = headerValue(headers, 'originator');
    const openaiBeta = headerValue(headers, 'openai-beta');
    if (originator === CODEX_ORIGINATOR || openaiBeta === CODEX_OPENAI_BETA) {
      return adapters.codex;
    }
  }

  return pathProvider;
}

export function gatewayProviderStatuses(adapters: GatewayProviderAdapters): GatewayProviderStatus[] {
  return (['claude', 'codex', 'omp'] as const).map((id) => {
    const adapter = adapters[id];
    const cliAccountCount = adapter.cliAccountCount?.() ?? 0;
    // Configured = the provider can actually serve: a bearer pool OR out-of-pool CLI-bridge
    // accounts. Codex ChatGPT-subscription accounts have NO API bearer (they are deliberately
    // filtered out of the bearer pool — launch.ts buildBearerEntries), so `pool !== null`
    // alone reported a working all-CLI codex deployment as unconfigured (WI-3068).
    const configured = (adapter.pool !== null || cliAccountCount > 0) && adapter.upstreamBase !== null;
    return {
      id: adapter.id,
      label: adapter.label,
      protocol: adapter.protocol,
      configured,
      cliAccountCount,
      upstreamBase: adapter.upstreamBase,
      unavailableMessage: configured ? null : adapter.unavailableMessage,
    };
  });
}
