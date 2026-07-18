/**
 * capacity-probe.ts — read-only gateway pool probes for the Scout layer (WI-5391 Part B).
 *
 * One raw snapshot reader, two consumers with DIFFERENT failure semantics:
 *
 *   - ROUTING (register-scout-action.ts `readScoutProviderCapacity`) derives booleans and
 *     fails OPEN to the historical Claude route when the probe is unavailable — never send
 *     Scout into an unknown provider on missing evidence.
 *   - AUDIT (scheduler.ts record-time discrimination) needs a TRISTATE: a failed probe is
 *     `undefined` (no contradiction possible — trust the denial's attestation), never a
 *     fabricated "available". Collapsing probe-failure into either boolean is exactly the
 *     evidence-free classification WI-5391 exists to remove.
 *
 * The snapshot is persisted verbatim into the scout tick detail on capacity-shaped
 * failures, so every exclusion from the error metric is retro-auditable: a 'no-capacity'
 * gate recorded while `healthyAccounts > 0` is the WI-4541 admission-defect signature.
 */

export interface ScoutPoolSnapshot {
  /** Epoch ms the gateway was probed — pairs with the failure instant for audit. */
  probedAtMs: number;
  /** Gateway `/stats.healthyAccounts` (Claude pool serviceable denominator); absent when the field was missing. */
  healthyAccounts?: number;
  /** Gateway `/stats.codexHealthyAccounts`; absent when the field was missing. */
  codexHealthyAccounts?: number;
  /** Gateway `/admin/config.providers.codex.configured === true`. */
  codexConfigured: boolean;
  /** Gateway `/admin/config.providers.codex.cliAccountCount`; absent when the field was missing. */
  codexCliAccountCount?: number;
}

/**
 * Probe the localhost pacing gateway's pool state without changing any routing state.
 * Returns `undefined` when either probe fails or times out (~1s) — the TRISTATE unknown,
 * deliberately distinct from "no healthy accounts".
 */
export async function readScoutPoolSnapshot(fetchImpl: typeof fetch = fetch): Promise<ScoutPoolSnapshot | undefined> {
  const base = `http://127.0.0.1:${Number(process.env.PAPERCUSP_GATEWAY_PORT) || 8788}`;
  try {
    const signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(1_000) : undefined;
    const [statsRes, configRes] = await Promise.all([
      fetchImpl(`${base}/stats`, signal ? { signal } : undefined),
      fetchImpl(`${base}/admin/config`, signal ? { signal } : undefined),
    ]);
    if (!statsRes.ok || !configRes.ok) return undefined;
    const stats = (await statsRes.json()) as { healthyAccounts?: unknown; codexHealthyAccounts?: unknown };
    const config = (await configRes.json()) as {
      providers?: { codex?: { configured?: unknown; cliAccountCount?: unknown } };
    };
    const codex = config.providers?.codex;
    return {
      probedAtMs: Date.now(),
      ...(typeof stats.healthyAccounts === 'number' ? { healthyAccounts: stats.healthyAccounts } : {}),
      ...(typeof stats.codexHealthyAccounts === 'number' ? { codexHealthyAccounts: stats.codexHealthyAccounts } : {}),
      codexConfigured: codex?.configured === true,
      ...(typeof codex?.cliAccountCount === 'number' ? { codexCliAccountCount: codex.cliAccountCount } : {}),
    };
  } catch {
    return undefined;
  }
}
