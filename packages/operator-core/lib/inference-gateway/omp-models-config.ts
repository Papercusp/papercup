/**
 * OMP (pi) inference-gateway model config — the OMP peer of codex's per-session
 * `config.toml` model_provider writer (orchestrator/spawn-mcp.ts
 * `buildSpawnCodexConfigToml`). See plan omp-account-pinning-gateway-2026-06-29
 * D-001 (mechanism) + D-002 (injection).
 *
 * pi reads its model config from `<HOME>/.omp/agent/models.yml` (legacy
 * `models.json` auto-migrated) — USER-LEVEL ONLY, no `--models` flag and no
 * agent-dir env var. So a session-scoped routing override is delivered by
 * writing this `models.yml` into a per-session OMP agent home and pointing the
 * `omp` subprocess at it via `HOME` (the fleet path's runtime-home-inheritance
 * already relocates HOME; the connect path seeds a session home — see P-005/P-006).
 *
 * Mechanism: OVERRIDE the built-in provider's `baseUrl` + `headers` (pi's
 * canonical providerOverride) so the session's existing anthropic/openai models
 * egress through the localhost inference gateway, pinned to an account. This
 * REUSES the existing anthropic / openai-compatible gateway adapters — there is
 * NO new "omp" gateway protocol. The gateway strips + reinjects the bound
 * account's real OAuth, so `apiKey` is a placeholder.
 */
import { ACCOUNT_HEADER, OWNER_HEADER, PRIORITY_HEADER } from './gateway';
import { gatewayPort } from './spawn-env';

/** The built-in pi provider whose routing we override. A Claude pool account
 *  routes the `anthropic` provider; an OpenAI/Codex pool account routes the
 *  `openai` provider. These are pi's own built-in provider ids. */
export type OmpGatewayProvider = 'anthropic' | 'openai';

/** Placeholder key sent upstream; the gateway strips + reinjects the real
 *  account OAuth (peer of codex's `experimental_bearer_token`). pi requires a
 *  key on a custom-routed provider, so we hand it an inert one rather than
 *  `auth: none` (which some pi versions treat as "skip this provider"). */
export const OMP_GATEWAY_PLACEHOLDER_KEY = 'papercusp-gateway';

/** Relative path, under the OMP agent HOME, of the model config pi reads. */
export const OMP_MODELS_REL_PATH = '.omp/agent/models.yml';

export interface OmpGatewayModelsConfigOpts {
  /** The pinned pool account id — REQUIRED. Absent ⇒ null (no pin, no config). */
  accountId?: string | null;
  /** Which built-in provider to route through the gateway. */
  provider: OmpGatewayProvider;
  /** Owner id (== spawnId) for gateway rate-shed attribution + stall-wake. */
  ownerId?: string | null;
  /** Spawn role → gateway admission tier (when GATEWAY_PRIORITY_TIERS is on). */
  priority?: string | null;
  /** Gateway port override (defaults to the resolved gatewayPort()). */
  port?: number;
}

export interface OmpGatewayModelsConfig {
  /** Path component pi reads, relative to the OMP agent HOME. */
  relPath: string;
  /** The `models.yml` bytes to write. */
  content: string;
  /** The header map baked into the provider override (for logging / tests). */
  headers: Record<string, string>;
  /** The resolved upstream base url the provider points at. */
  baseUrl: string;
}

/** Map a pool account provider to the pi built-in provider it routes. */
export function ompProviderForAccountProvider(p: 'claude' | 'codex'): OmpGatewayProvider {
  return p === 'codex' ? 'openai' : 'anthropic';
}

/** Anthropic egress hits the gateway root; OpenAI-compatible egress hits `/v1`
 *  (matches provider-adapters.ts `providerForGatewayPath` path routing). */
function gatewayBaseUrl(provider: OmpGatewayProvider, port: number): string {
  const root = `http://127.0.0.1:${port}`;
  return provider === 'openai' ? `${root}/v1` : root;
}

/** Quote + escape a scalar for a YAML double-quoted string. */
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build the per-session `models.yml` that routes a pinned OMP session through
 * the inference gateway. Returns `null` when no account is pinned (fail-soft —
 * the session then uses pi's normal direct egress, byte-identical to today),
 * mirroring codex's empty-config return.
 */
export function ompGatewayModelsConfig(
  opts: OmpGatewayModelsConfigOpts,
): OmpGatewayModelsConfig | null {
  const accountId = opts.accountId?.trim();
  if (!accountId) return null;

  const port = opts.port && opts.port > 0 ? opts.port : gatewayPort();
  const baseUrl = gatewayBaseUrl(opts.provider, port);

  const headers: Record<string, string> = { [ACCOUNT_HEADER]: accountId };
  const ownerId = opts.ownerId?.trim();
  if (ownerId) headers[OWNER_HEADER] = ownerId;
  const priority = opts.priority?.trim();
  if (priority) headers[PRIORITY_HEADER] = priority;

  const headerLines = Object.entries(headers).map(
    ([k, v]) => `      ${yamlString(k)}: ${yamlString(v)}`,
  );

  const content = [
    '# BEGIN PAPERCUSP_OMP_GATEWAY',
    '# Managed by operator-core inference-gateway/omp-models-config.ts.',
    '# Routes this session\'s pinned provider through the Papercusp inference',
    '# gateway (account-affinity + pacing). The gateway strips + reinjects the',
    `# bound account's OAuth, so the apiKey below is an inert placeholder.`,
    'providers:',
    `  ${opts.provider}:`,
    `    baseUrl: ${yamlString(baseUrl)}`,
    `    apiKey: ${yamlString(OMP_GATEWAY_PLACEHOLDER_KEY)}`,
    '    headers:',
    ...headerLines,
    '# END PAPERCUSP_OMP_GATEWAY',
    '',
  ].join('\n');

  return { relPath: OMP_MODELS_REL_PATH, content, headers, baseUrl };
}
