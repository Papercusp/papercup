/**
 * The operator's hourly anchoring pass (agent-economy-flywheel-2026-08-30
 * P-041, D-024 §2 and §5). For every workspace with chain links it runs one
 * anchor tick, then checks the cadence. When the last completed hour has no
 * anchor (a missing key, an unfunded key, an RPC outage, a revert) it files ONE
 * deduplicated alert per workspace, keyed `ledger-anchor:missed-hour:<ws>`.
 *
 * The DBOS schedule (dbos/ledger-anchor-workflow.ts) and the
 * `cupboard:ledger-anchor` tool both call `runLedgerAnchorPass`.
 */
import type { Sql } from 'postgres';
import {
  checkAnchorCadence,
  runAnchorTick,
  type AnchorAlertSink,
  type AnchorBackend,
  type AnchorLinkFeed,
  type AnchorTickResult,
  type CadenceVerdict,
  type LedgerAnchorStore,
  type MissedHourAlert,
} from './ledger-anchor';
import { resolveAnchorBackend } from './ledger-anchor-eas';
import { anchorWorkspaces, ledgerAnchorLogId, pgAnchorLinkFeed, pgLedgerAnchorStore } from './ledger-anchor-store';

export const missedHourWatchdogKey = (workspaceId: string): string => `ledger-anchor:missed-hour:${workspaceId}`;

const TERMINAL_STATES = new Set(['done', 'dropped', 'resolved', 'closed']);

export interface MissedHourAlertDeps {
  /** Whether a non-terminal alert already carries this watchdog key. */
  readonly hasOpenAlert?: (watchdogKey: string) => Promise<boolean>;
  readonly file?: (input: {
    readonly title: string;
    readonly body: string;
    readonly watchdogKey: string;
    readonly workspaceId: string;
  }) => Promise<void>;
  /** Why the last tick for a workspace failed, when it did. */
  readonly detailFor?: (workspaceId: string) => string | null;
}

/** Files one alert per workspace while it stays open (a stable watchdog key). */
export function missedHourAlertSink(deps: MissedHourAlertDeps = {}): AnchorAlertSink {
  const hasOpenAlert =
    deps.hasOpenAlert ??
    (async (key: string) => {
      const { findIssuesByWatchdogKeys } = await import('../issues-engineer');
      return (await findIssuesByWatchdogKeys([key])).some((i) => !TERMINAL_STATES.has(String(i.state)));
    });
  const file =
    deps.file ??
    (async (input: { title: string; body: string; watchdogKey: string; workspaceId: string }) => {
      const { captureImprovement } = await import('../harness/improvements/capture-core');
      await captureImprovement({
        title: input.title,
        kind: 'bug',
        severity: 'major',
        body: input.body,
        watchdogKey: input.watchdogKey,
        workspaceId: input.workspaceId,
        scope: 'harness:papercusp',
        sourceRole: 'system',
        filedByRole: 'ledger-anchor-watchdog',
        createdBy: 'system:ledger-anchor',
        paths: ['packages/operator-core/lib/cupboard/ledger-anchor-runtime.ts'],
      });
    });
  return {
    async missedHour(alert: MissedHourAlert): Promise<void> {
      const watchdogKey = missedHourWatchdogKey(alert.workspaceId);
      if (await hasOpenAlert(watchdogKey)) return;
      const detail = deps.detailFor?.(alert.workspaceId) ?? null;
      const last = alert.lastWindowEnd === null ? 'never' : new Date(alert.lastWindowEnd * 1000).toISOString();
      await file({
        watchdogKey,
        workspaceId: alert.workspaceId,
        title: `Ledger anchoring missed ${alert.hoursBehind} hour(s) for workspace ${alert.workspaceId}`,
        body: [
          `The hourly ledger anchor (P-041) for workspace ${alert.workspaceId} is ${alert.hoursBehind} hour(s) behind.`,
          `Last anchored window ended: ${last}. Expected an anchor ending at ${new Date(alert.expectedWindowEnd * 1000).toISOString()}.`,
          detail ? `Last tick failure: ${detail}` : 'No tick failure was recorded in this pass.',
          'Check with cupboard:ledger-anchor { op: "status" }; force a pass with { op: "run" }.',
          'Common causes: anchor key missing or unfunded (Base Sepolia test ETH), RPC outage, PAPERCUSP_LEDGER_ANCHOR_* misconfiguration.',
        ].join('\n'),
      });
    },
  };
}

export type WorkspaceTick =
  | AnchorTickResult
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: string };

export interface LedgerAnchorPassResult {
  readonly backend: string | null;
  /** Why no backend is available (missing key, disabled, …). */
  readonly backendUnavailable: string | null;
  readonly workspaces: readonly { readonly workspaceId: string; readonly tick: WorkspaceTick; readonly cadence: CadenceVerdict | null }[];
}

export async function runLedgerAnchorPass(
  input: {
    readonly nowSeconds?: number;
    readonly sql?: Sql;
    /** Omit to resolve from the environment; `null` runs cadence checks only. */
    readonly backend?: AnchorBackend | null;
    readonly alertDeps?: MissedHourAlertDeps;
    readonly workspaces?: readonly string[];
    readonly store?: LedgerAnchorStore;
    readonly feed?: AnchorLinkFeed;
  } = {},
): Promise<LedgerAnchorPassResult> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  let backend: AnchorBackend | null;
  let backendUnavailable: string | null = null;
  let alertsEnabled = true;
  if (input.backend !== undefined) {
    backend = input.backend;
  } else {
    const resolved = resolveAnchorBackend();
    backend = resolved.ok ? resolved.backend : null;
    if (!resolved.ok) {
      backendUnavailable = `${resolved.reason}: ${resolved.detail}`;
      // An install that turned anchoring off is not missing hours.
      alertsEnabled = resolved.reason !== 'disabled';
    }
  }
  const store = input.store ?? pgLedgerAnchorStore(input.sql);
  const feed = input.feed ?? pgAnchorLinkFeed(input.sql);
  const failures = new Map<string, string>();
  const alert = missedHourAlertSink({
    ...input.alertDeps,
    detailFor: (ws) => failures.get(ws) ?? (backendUnavailable ? `no anchor backend (${backendUnavailable})` : null),
  });

  const results: { workspaceId: string; tick: WorkspaceTick; cadence: CadenceVerdict | null }[] = [];
  for (const workspaceId of input.workspaces ?? (await anchorWorkspaces(input.sql))) {
    let tick: WorkspaceTick;
    if (!backend) {
      tick = { status: 'skipped', reason: backendUnavailable ?? 'no anchor backend' };
    } else {
      try {
        tick = await runAnchorTick({ workspaceId, logId: ledgerAnchorLogId(workspaceId), nowSeconds, store, feed, backend });
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
        failures.set(workspaceId, message);
        tick = { status: 'failed', error: message };
      }
    }
    const cadence = alertsEnabled ? await checkAnchorCadence({ workspaceId, nowSeconds, store, alert }) : null;
    results.push({ workspaceId, tick, cadence });
  }
  return { backend: backend?.kind ?? null, backendUnavailable, workspaces: results };
}
