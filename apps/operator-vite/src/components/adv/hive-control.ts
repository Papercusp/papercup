/**
 * Shared hive start/stop control (start-hive-wake-orchestration P-006).
 *
 * Extracted from AdvNowRunning so the central Hives-tab control (LocalHivesControl)
 * and the always-visible header "N hives running" pill (HivesRunningPill) drive the
 * SAME gated/audited dispatch and read the same `hive.controlState` sync query —
 * one write path, no drift. `hive:start` / `hive:pause` flip the persisted started
 * bit and fire `notifySyncInvalidate('hive.controlState')`, so every consumer
 * refreshes live after a toggle.
 */

/** One row of the `hive.controlState` sync query (per registered LOCAL hive). */
export interface HiveControlRow {
  slug: string;
  started: boolean;
  nextFireAt?: string | null;
  lastWakeAt?: string | null;
  watchdogFires24h?: number;
}

/** Count of started hives. Pure — exported for unit tests. */
export function countStarted(rows: readonly HiveControlRow[]): number {
  return rows.filter((r) => r.started === true).length;
}

/**
 * Pluralized label for the header pill ("N pot(s) running"). Pure + hook-free so
 * it stays unit-testable — the CALLER supplies the resolved brand noun (singular,
 * plural) from the active lexicon (restore-pot-lexicon P-006). Defaults to the
 * literal 'hive'/'hives' only for the bare unit test; production always passes the
 * lexicon words.
 */
export function hivesRunningLabel(n: number, singular = 'hive', plural = 'hives'): string {
  return `${n} ${n === 1 ? singular : plural} running`;
}

/**
 * Fire a hive control tool through the loopback palette bridge — the full
 * gated/audited dispatch (the same path the old global-header HiveStartPauseButton
 * used). Throws on any failure so callers can toast.
 */
export async function runHiveControl(
  tool: 'hive:start' | 'hive:pause',
  slug: string,
  extraArgs: Record<string, unknown> = {},
): Promise<void> {
  const res = await fetch('/api/agent-mcp/run-tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: tool, args: { harness: slug, ...extraArgs }, confirmed: true }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    message?: string;
    result?: { content?: Array<{ text?: string }> };
  };
  if (!res.ok || !body.ok) {
    throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  }
  const text = body.result?.content?.[0]?.text;
  const payload = text ? (JSON.parse(text) as { ok?: boolean; message?: string }) : { ok: true };
  if (payload.ok === false) throw new Error(payload.message ?? `${tool} refused`);
}
