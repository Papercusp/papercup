/**
 * OMP (pi) inference-gateway model config — the OMP peer of codex's per-session
 * `config.toml` model_provider writer (orchestrator/spawn-mcp.ts
 * `buildSpawnCodexConfigToml`). See plan omp-account-pinning-gateway-2026-06-29
 * D-001/D-002 (mechanism+injection) and D-006 (the shape below, VERIFIED on real omp).
 *
 * pi reads its model config from `<HOME>/.omp/agent/models.yml` (legacy
 * `models.json` auto-migrated) — USER-LEVEL ONLY, no `--models` flag and no
 * agent-dir env var. So a session-scoped routing override is delivered by
 * writing this `models.yml` into a per-session OMP agent home and pointing the
 * `omp` subprocess at it via `HOME` (P-005 connect / P-006 fleet).
 *
 * Mechanism (D-006, verified end-to-end against omp 15.5.13): define a DEDICATED
 * provider (`papercusp-gateway`) whose `baseUrl` → the localhost inference gateway,
 * whose `headers` carry the account pin, and that exposes the session's models —
 * then select `papercusp-gateway/<model>`. omp then POSTs `/v1/messages`
 * (anthropic) or `/v1/responses` (openai) to the gateway WITH the
 * `x-papercusp-account` header, in the wire shape the existing anthropic /
 * openai-compatible gateway adapters expect (NO new "omp" protocol; the gateway
 * strips+reinjects the bound account's OAuth, so `apiKey` is an inert placeholder).
 *
 * Why a DEDICATED provider, not a bare `providers.anthropic` baseUrl override:
 * pi's canonical-model equivalence resolves a built-in id like `claude-sonnet-4`
 * to cloud gateways (bedrock / cloudflare-ai-gateway) BEFORE a built-in-provider
 * override applies; a unique provider id is selected deterministically (D-006).
 */
import { ACCOUNT_HEADER, OWNER_HEADER, PRIORITY_HEADER } from './gateway';
import { gatewayPort } from './spawn-env';

/** The built-in account provider an OMP session pins to. A Claude pool account
 *  routes the `anthropic` wire (claude models); an OpenAI/Codex account routes
 *  the `openai` wire. */
export type OmpGatewayProvider = 'anthropic' | 'openai';

/** Inert key sent upstream; the gateway strips + reinjects the real account
 *  OAuth (peer of codex's `experimental_bearer_token`). */
export const OMP_GATEWAY_PLACEHOLDER_KEY = 'papercusp-gateway';

/** The dedicated provider id we inject (NOT pi's built-in `anthropic`/`openai`). */
export const OMP_GATEWAY_PROVIDER_ID = 'papercusp-gateway';

/** Relative path, under the OMP agent HOME, of the model config pi reads. */
export const OMP_MODELS_REL_PATH = '.omp/agent/models.yml';

/** Default model ids exposed through the gateway provider, per wire. Callers
 *  (the spawn site) SHOULD pass the role's actual model id(s); these are the
 *  fallback so a config is always usable. */
const DEFAULT_MODELS: Record<OmpGatewayProvider, string[]> = {
  // Must be a VALID dated Anthropic id — the gateway forwards the model id verbatim to
  // api.anthropic.com, which 404s the bare alias `claude-sonnet-4` (`not_found_error`).
  // Callers that don't pass opts.models inherit this, so a bare id breaks real-account
  // spawns (the shipped verification used a local probe model, so it never surfaced).
  anthropic: ['claude-sonnet-4-6'],
  openai: ['gpt-5-codex'],
};

/** pi `api` (wire-protocol) value per provider. */
const PROVIDER_API: Record<OmpGatewayProvider, string> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-responses',
};

export interface OmpGatewayModelsConfigOpts {
  /** The pinned pool account id — REQUIRED. Absent ⇒ null (no pin, no config). */
  accountId?: string | null;
  /** Which wire the pinned account speaks (claude→anthropic, openai/codex→openai). */
  provider: OmpGatewayProvider;
  /** Owner id (== spawnId) for gateway rate-shed attribution + stall-wake. */
  ownerId?: string | null;
  /** Spawn role → gateway admission tier (when GATEWAY_PRIORITY_TIERS is on). */
  priority?: string | null;
  /** Gateway port override (defaults to the resolved gatewayPort()). */
  port?: number;
  /** Model ids to expose through the gateway provider (defaults per provider). */
  models?: string[];
}

export interface OmpGatewayModelsConfig {
  /** Path component pi reads, relative to the OMP agent HOME. */
  relPath: string;
  /** The `models.yml` bytes to write. */
  content: string;
  /** The injected provider id (`papercusp-gateway`). */
  providerId: string;
  /** `papercusp-gateway/<first-model>` — set this in config.yml modelRoles or pass via --model. */
  modelSelector: string;
  /** The model ids exposed through the provider. */
  models: string[];
  /** The header map baked into the provider (for logging / tests). */
  headers: Record<string, string>;
  /** The resolved upstream base url the provider points at. */
  baseUrl: string;
}

/** Map a pool account provider to the pi wire it routes. */
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
 * the session then uses pi's normal direct egress), mirroring codex's empty return.
 */
export function ompGatewayModelsConfig(
  opts: OmpGatewayModelsConfigOpts,
): OmpGatewayModelsConfig | null {
  const accountId = opts.accountId?.trim();
  if (!accountId) return null;

  const port = opts.port && opts.port > 0 ? opts.port : gatewayPort();
  const baseUrl = gatewayBaseUrl(opts.provider, port);
  const api = PROVIDER_API[opts.provider];
  const models = (opts.models && opts.models.length > 0 ? opts.models : DEFAULT_MODELS[opts.provider])
    .map((m) => m.trim())
    .filter(Boolean);
  const modelIds = models.length > 0 ? models : DEFAULT_MODELS[opts.provider];

  const headers: Record<string, string> = { [ACCOUNT_HEADER]: accountId };
  const ownerId = opts.ownerId?.trim();
  if (ownerId) headers[OWNER_HEADER] = ownerId;
  const priority = opts.priority?.trim();
  if (priority) headers[PRIORITY_HEADER] = priority;

  const headerLines = Object.entries(headers).map(
    ([k, v]) => `      ${yamlString(k)}: ${yamlString(v)}`,
  );

  const modelLines = modelIds.flatMap((id) => [
    `      - id: ${yamlString(id)}`,
    `        name: ${yamlString(`Papercusp Gateway ${id}`)}`,
    `        api: ${api}`,
    `        input: [text]`,
    `        contextWindow: 200000`,
    `        maxTokens: 8192`,
  ]);

  const content = [
    '# BEGIN PAPERCUSP_OMP_GATEWAY',
    '# Managed by operator-core inference-gateway/omp-models-config.ts (D-006).',
    `# Routes this session's models through the Papercusp inference gateway`,
    `# (account-affinity + pacing). The gateway strips + reinjects the bound`,
    `# account's OAuth, so apiKey below is an inert placeholder.`,
    'providers:',
    `  ${OMP_GATEWAY_PROVIDER_ID}:`,
    `    baseUrl: ${yamlString(baseUrl)}`,
    `    apiKey: ${yamlString(OMP_GATEWAY_PLACEHOLDER_KEY)}`,
    `    api: ${api}`,
    '    auth: apiKey',
    '    headers:',
    ...headerLines,
    '    models:',
    ...modelLines,
    '# END PAPERCUSP_OMP_GATEWAY',
    '',
  ].join('\n');

  return {
    relPath: OMP_MODELS_REL_PATH,
    content,
    providerId: OMP_GATEWAY_PROVIDER_ID,
    modelSelector: `${OMP_GATEWAY_PROVIDER_ID}/${modelIds[0]}`,
    models: modelIds,
    headers,
    baseUrl,
  };
}
