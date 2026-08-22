"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseAsString, parseAsStringEnum, useQueryState } from "nuqs";
import { toast } from "sonner";
import { FLAGS } from "@papercusp/flags";
import type {
  ExternalTriggerAdminSnapshot,
  ExternalTriggerBindingAdminRow,
} from "@papercusp/operator-core/lib/external-triggers/admin";
import { useFlag } from "@/lib/flag-hooks";
import "./triggers.css";

type View = "bindings" | "sources" | "runs";
type LoadState = "loading" | "ok" | "error";

const VIEW_LABELS: Record<View, string> = {
  bindings: "Bindings",
  sources: "Sources",
  runs: "Recent runs",
};

function numberFromPolicy(
  policy: Record<string, unknown>,
  camel: string,
  snake: string,
): number | null {
  const value = policy[camel] ?? policy[snake];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatTime(value: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function compactJson(value: Record<string, unknown>): string {
  return Object.keys(value).length === 0 ? "none" : JSON.stringify(value);
}

export default function TriggersClient() {
  const flagEnabled = useFlag(FLAGS.TRIGGERS_ADMIN);
  const [view, setView] = useQueryState(
    "view",
    parseAsStringEnum<View>(["bindings", "sources", "runs"]).withDefault(
      "bindings",
    ),
  );
  const [selectedBindingId, setSelectedBindingId] = useQueryState(
    "binding",
    parseAsString,
  );
  const [payload, setPayload] = useState<ExternalTriggerAdminSnapshot | null>(
    null,
  );
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [maxRuns, setMaxRuns] = useState("");
  const [windowSeconds, setWindowSeconds] = useState("60");

  const load = useCallback(async () => {
    if (!flagEnabled) return;
    setState("loading");
    try {
      const response = await fetch("/api/admin/triggers", {
        cache: "no-store",
      });
      const body = (await response.json()) as ExternalTriggerAdminSnapshot & {
        detail?: string;
      };
      if (!response.ok)
        throw new Error(body.detail ?? `HTTP ${response.status}`);
      setPayload(body);
      setState("ok");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  }, [flagEnabled]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedBinding = useMemo(
    () =>
      payload?.bindings.find((binding) => binding.id === selectedBindingId) ??
      null,
    [payload, selectedBindingId],
  );

  useEffect(() => {
    if (!selectedBinding) return;
    const limit = numberFromPolicy(
      selectedBinding.stormPolicy,
      "maxRuns",
      "max_runs",
    );
    const window = numberFromPolicy(
      selectedBinding.stormPolicy,
      "windowSeconds",
      "window_seconds",
    );
    setMaxRuns(limit === null ? "" : String(limit));
    setWindowSeconds(String(window ?? 60));
  }, [selectedBinding]);

  const patch = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch("/api/admin/triggers", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
      detail?: string;
    };
    if (!response.ok || result.ok !== true) {
      throw new Error(
        result.detail ?? result.error ?? `HTTP ${response.status}`,
      );
    }
  }, []);

  const setArmed = useCallback(
    async (binding: ExternalTriggerBindingAdminRow, armed: boolean) => {
      const verb = armed ? "Arm" : "Disarm";
      const consequence = armed
        ? "Matching events may immediately start this plan."
        : "Matching events will stop starting this plan until it is armed again.";
      if (!window.confirm(`${verb} ${binding.eventPattern}?\n\n${consequence}`))
        return;
      setBusy(`armed:${binding.id}`);
      try {
        await patch({ op: "set-armed", id: binding.id, armed, confirm: true });
        toast.success(
          `${binding.eventPattern} ${armed ? "armed" : "disarmed"}`,
        );
        await load();
      } catch (cause) {
        toast.error(`${verb} failed`, {
          description: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        setBusy(null);
      }
    },
    [load, patch],
  );

  const saveStormPolicy = useCallback(async () => {
    if (!selectedBinding) return;
    const parsedMax = maxRuns.trim() === "" ? null : Number(maxRuns);
    const parsedWindow = Number(windowSeconds);
    if (
      (parsedMax !== null &&
        (!Number.isInteger(parsedMax) || parsedMax <= 0)) ||
      !Number.isInteger(parsedWindow) ||
      parsedWindow <= 0
    ) {
      toast.error("Storm policy needs positive whole numbers");
      return;
    }
    setBusy(`storm:${selectedBinding.id}`);
    try {
      await patch({
        op: "set-storm-policy",
        id: selectedBinding.id,
        maxRuns: parsedMax,
        windowSeconds: parsedWindow,
      });
      toast.success("Storm policy saved");
      await load();
      await setSelectedBindingId(null);
    } catch (cause) {
      toast.error("Storm policy update failed", {
        description: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setBusy(null);
    }
  }, [
    load,
    maxRuns,
    patch,
    selectedBinding,
    setSelectedBindingId,
    windowSeconds,
  ]);

  if (!flagEnabled) {
    return (
      <div className="tr-shell tr-disabled">
        External trigger administration is switched off.
      </div>
    );
  }

  return (
    <main className="tr-shell">
      <section className="tr-intro" aria-labelledby="tr-title">
        <div>
          <span className="tr-kicker">Triggered plans</span>
          <h2 id="tr-title">External trigger control</h2>
          <p>
            Review source health and plan bindings. New bindings stay off until
            an owner deliberately arms them.
          </p>
        </div>
        <button
          type="button"
          className="tr-button tr-button-secondary"
          onClick={() => void load()}
          disabled={state === "loading"}
        >
          Refresh
        </button>
      </section>

      {state === "loading" && (
        <div className="tr-state" role="status" aria-live="polite">
          Loading triggers…
        </div>
      )}
      {state === "error" && (
        <div className="tr-state tr-state-error" role="alert">
          <span>Trigger data could not be loaded: {error}</span>
          <button
            type="button"
            className="tr-button tr-button-secondary"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      )}
      {state === "ok" && payload && !payload.enabled && (
        <div className="tr-state">
          External trigger administration is switched off.
        </div>
      )}
      {state === "ok" && payload?.enabled && (
        <>
          <section className="tr-metrics" aria-label="Trigger summary">
            <Metric label="Sources" value={payload.counts.sources} />
            <Metric label="Bindings" value={payload.counts.bindings} />
            <Metric label="Armed" value={payload.counts.armed} tone="good" />
            <Metric
              label="Failures · 24h"
              value={payload.counts.recentFailures}
              tone={payload.counts.recentFailures > 0 ? "bad" : "neutral"}
            />
          </section>

          <nav className="tr-tabs" aria-label="Trigger admin views">
            {(Object.keys(VIEW_LABELS) as View[]).map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={`tr-tab${view === candidate ? " active" : ""}`}
                aria-pressed={view === candidate}
                onClick={() => void setView(candidate)}
              >
                {VIEW_LABELS[candidate]}
              </button>
            ))}
          </nav>

          {view === "bindings" && (
            <section className="tr-list" aria-label="Trigger bindings">
              {payload.bindings.length === 0 && (
                <Empty message="No trigger bindings yet. Create one with the triggers agent verbs; it will start off." />
              )}
              {payload.bindings.map((binding) => {
                const policyMax = numberFromPolicy(
                  binding.stormPolicy,
                  "maxRuns",
                  "max_runs",
                );
                const policyWindow =
                  numberFromPolicy(
                    binding.stormPolicy,
                    "windowSeconds",
                    "window_seconds",
                  ) ?? 60;
                return (
                  <article
                    key={binding.id}
                    className={`tr-card${binding.armed ? "" : " muted"}`}
                  >
                    <div className="tr-card-main">
                      <div className="tr-card-heading">
                        <code>{binding.eventPattern}</code>
                        <span className="tr-badge">{binding.sourceKind}</span>
                        <span
                          className={`tr-badge status-${binding.sourceStatus}`}
                        >
                          {binding.sourceStatus}
                        </span>
                      </div>
                      <div className="tr-meta">
                        → {binding.planHarnessSlug}/{binding.planSlug}
                      </div>
                      <div className="tr-meta">
                        filter: {compactJson(binding.eventFilter)}
                      </div>
                      <div className="tr-meta">
                        storm:{" "}
                        {policyMax === null
                          ? "unbounded"
                          : `${policyMax} run${policyMax === 1 ? "" : "s"}`}{" "}
                        / {policyWindow}s
                      </div>
                      <div className="tr-meta">
                        last run:{" "}
                        {binding.lastRun
                          ? `${binding.lastRun.status} · ${formatTime(binding.lastRun.triggeredAt)}`
                          : "never"}
                        {binding.lastRun?.error
                          ? ` · ${binding.lastRun.error}`
                          : ""}
                      </div>
                    </div>
                    <div className="tr-card-actions">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={binding.armed}
                        aria-label={`${binding.armed ? "Disarm" : "Arm"} ${binding.eventPattern}`}
                        className={`tr-switch${binding.armed ? " on" : ""}`}
                        disabled={busy !== null}
                        onClick={() => void setArmed(binding, !binding.armed)}
                      >
                        <span />
                      </button>
                      <strong className={binding.armed ? "tr-good" : ""}>
                        {binding.armed ? "Armed" : "Off"}
                      </strong>
                      <button
                        type="button"
                        className="tr-link"
                        onClick={() => void setSelectedBindingId(binding.id)}
                      >
                        Storm policy
                      </button>
                    </div>
                  </article>
                );
              })}
            </section>
          )}

          {view === "sources" && (
            <section className="tr-list" aria-label="Trigger sources">
              {payload.sources.length === 0 && (
                <Empty message="No external sources are configured yet." />
              )}
              {payload.sources.map((source) => (
                <article key={source.id} className="tr-card">
                  <div className="tr-card-main">
                    <div className="tr-card-heading">
                      <strong>{source.kind}</strong>
                      <span className={`tr-badge status-${source.status}`}>
                        {source.status}
                      </span>
                    </div>
                    <div className="tr-meta">
                      {source.bindingCount} binding
                      {source.bindingCount === 1 ? "" : "s"} ·{" "}
                      {source.armedBindingCount} armed
                    </div>
                    <div className="tr-meta">
                      last connected: {formatTime(source.lastConnectedAt)}
                    </div>
                    <div className="tr-meta">
                      credential:{" "}
                      {source.credentialRef ? "configured" : "not configured"} ·
                      failures 24h: {source.failedDeliveries24h}
                    </div>
                    {source.lastError && (
                      <div className="tr-error-copy">{source.lastError}</div>
                    )}
                  </div>
                </article>
              ))}
            </section>
          )}

          {view === "runs" && (
            <section className="tr-table-wrap" aria-label="Recent trigger runs">
              {payload.recentRuns.length === 0 ? (
                <Empty message="No external-trigger runs have fired yet." />
              ) : (
                <table className="tr-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Event</th>
                      <th>Plan</th>
                      <th>Attempts</th>
                      <th>Triggered</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payload.recentRuns.map((run) => (
                      <tr key={run.id}>
                        <td>
                          <span className={`tr-badge run-${run.status}`}>
                            {run.status}
                          </span>
                        </td>
                        <td>
                          <code>{run.eventPattern}</code>
                          <small>{run.sourceKind}</small>
                        </td>
                        <td>
                          {run.planHarnessSlug}/{run.planSlug}
                        </td>
                        <td>{run.attempts}</td>
                        <td>{formatTime(run.triggeredAt)}</td>
                        <td>
                          {run.error ??
                            (run.planRunRef
                              ? `plan run ${run.planRunRef}`
                              : "—")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </>
      )}

      {selectedBinding && (
        <div
          className="tr-drawer-backdrop"
          role="presentation"
          onMouseDown={() => void setSelectedBindingId(null)}
        >
          <aside
            className="tr-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tr-storm-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="tr-drawer-head">
              <div>
                <span className="tr-kicker">
                  {selectedBinding.eventPattern}
                </span>
                <h3 id="tr-storm-title">Storm policy</h3>
              </div>
              <button
                type="button"
                className="tr-close"
                aria-label="Close storm policy"
                onClick={() => void setSelectedBindingId(null)}
              >
                ×
              </button>
            </div>
            <p>
              Bound how many plan runs this binding may start inside a rolling
              window. Leave maximum runs blank for no bound.
            </p>
            <label>
              Maximum runs
              <input
                type="number"
                min={1}
                value={maxRuns}
                onChange={(event) => setMaxRuns(event.target.value)}
                placeholder="Unlimited"
              />
            </label>
            <label>
              Window in seconds
              <input
                type="number"
                min={1}
                value={windowSeconds}
                onChange={(event) => setWindowSeconds(event.target.value)}
              />
            </label>
            <div className="tr-drawer-actions">
              <button
                type="button"
                className="tr-button tr-button-secondary"
                onClick={() => void setSelectedBindingId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="tr-button"
                disabled={busy !== null}
                onClick={() => void saveStormPolicy()}
              >
                Save policy
              </button>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "good" | "bad";
}) {
  return (
    <div className={`tr-metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return <div className="tr-empty">{message}</div>;
}
