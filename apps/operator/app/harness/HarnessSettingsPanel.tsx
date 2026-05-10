'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useSyncQuery } from '@restart/sync';

/**
 * Per-harness Settings panel — one tab inside the harness UI.
 *
 * Replaces the old click-to-edit popover on the "Lanes" stat card AND
 * the global /settings/orchestrator page. All controls live per-harness
 * in the spec (`config.json` → parallelWorkers.*) so each harness can
 * carry its own adaptive vocabulary and concurrency settings.
 *
 * Sections:
 *   1. Parallel workers — max, mode, branchIsolation, workersPerFeature
 *   2. Adaptive tiers — only visible when mode=adaptive. Edits the
 *      `parallelWorkers.adaptive.{tiers,labels,rubric}` block on the spec.
 *   3. Adaptive telemetry — recent NEXT_WORKER decisions for this
 *      harness. Read-only, manual refresh button.
 */

type Mode = 'lane' | 'competition' | 'adaptive';

interface AdaptiveCfg {
  tiers: number[];
  labels: string[];
  rubric: string;
}

interface ParallelWorkersCfg {
  max: number;
  mode: Mode;
  workersPerFeature: number | null;
  /** Cap distinct features in flight. null = no separate cap (only
   *  max-workers limits). 1 = traditional one-feature-at-a-time. */
  maxFeaturesInFlight: number | null;
  /** Feature flag for the new worker chunk loop (atomic file locks,
   *  per-chunk typecheck gate, replan + escalate). */
  useChunkLoop: boolean;
  /** L1 typecheck command run after each chunk's edits. */
  workingStateCheck: string;
  /** Number of typecheck-rejection retries before escalating. */
  replanStrikes: number;
  /** Agent role taken over on chunk escalation. */
  escalateToRole: string;
  adaptive: AdaptiveCfg;
}

interface BranchIsoCfg {
  enabled: boolean;
  useWorktrees: boolean;
}

interface AiBackendRowCfg {
  /** Empty string = applies as harness-wide default. */
  role: string;
  agentCmd: string;
  model: string;
  /** Whitespace-split when persisted. Stored as the raw user string. */
  extraArgsRaw: string;
}

/**
 * Roles the per-role override dropdown surfaces. The orchestrator can
 * carry overrides for any role string — this list is just the curated
 * "obvious" set; users can add a custom role name via the input.
 */
const KNOWN_ROLES = [
  'orchestrator',
  'worker',
  'validator',
  'debugger',
  'scoper',
  'architect',
  'expert',
  'feedback',
  'reviewer',
  'curator',
  'documenter',
  'scanner',
];

const DEFAULT_TIERS = [1, 2, 4];
const DEFAULT_LABELS = ['trivial', 'normal', 'hard'];
const DEFAULT_RUBRIC =
  '- Tier 1 (trivial): copy/text changes, single-file edits, well-isolated bug fixes.\n' +
  '- Tier 2 (normal): multi-file changes with clear scope, no architectural decisions.\n' +
  '- Tier 3 (hard): cross-cutting refactors, ambiguous specs, security-sensitive areas.';

const RUBRIC_MAX_BYTES = 8 * 1024;

interface TelemetryRow {
  id: number;
  ts: number;
  feature_id: string;
  requested_n: number;
  actual_n: number;
  tier_label: string | null;
  available_at_decision: number | null;
  max_slots: number | null;
  outcome: string | null;
  outcome_ts: number | null;
  duration_ms: number | null;
}

export default function HarnessSettingsPanel({
  slug,
  phase,
}: {
  slug: string;
  phase: string;
}) {
  const [parallel, setParallel] = useState<ParallelWorkersCfg>({
    max: 1,
    mode: 'lane',
    workersPerFeature: null,
    maxFeaturesInFlight: null,
    useChunkLoop: false,
    workingStateCheck: 'pnpm typecheck',
    replanStrikes: 3,
    escalateToRole: 'debugger',
    adaptive: { tiers: DEFAULT_TIERS, labels: DEFAULT_LABELS, rubric: DEFAULT_RUBRIC },
  });
  const [branchIso, setBranchIso] = useState<BranchIsoCfg>({
    enabled: false,
    useWorktrees: false,
  });
  /**
   * AI backend rows. The first row (role='') is the harness-wide default;
   * any further rows are per-role overrides. Resolution order at runtime:
   * roles[role] ⊕ default ⊕ process env (AGENT_CMD).
   *
   * Secrets: this UI is plaintext-config.json only — do NOT enter API
   * keys here. They belong in process env / the encrypted-credentials
   * store (future work, post-impl report).
   */
  const [aiBackend, setAiBackend] = useState<AiBackendRowCfg[]>([
    { role: '', agentCmd: '', model: '', extraArgsRaw: '' },
  ]);
  const [originalConfig, setOriginalConfig] = useState<Record<string, unknown>>({});

  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const [telemetry, setTelemetry] = useState<TelemetryRow[]>([]);
  const [telemetryLoading, setTelemetryLoading] = useState(false);

  // Eager via Zero — harnessProjectFiles.byHarness mirrors PG's
  // harness_project_files row that holds config.json. Replaces the
  // lazy /spec?phase= round-trip on mount/slug/phase change. Cross-tab
  // edits to config.json push updates here automatically. REST-fallback
  // path retained below for harnesses that pre-date the mirror.
  const { data: settingsConfigRows } = useSyncQuery<{
    harnessSlug: string;
    config?: string | null;
  }>({
    queryName: 'harnessProjectFiles.byHarness',
    args: { harnessSlug: slug },
    enabled: !!slug,
  });
  const applyLoadedConfig = useCallback((cfg: Record<string, unknown>) => {
    setOriginalConfig(cfg);
    const pwRaw = (cfg.parallelWorkers ?? {}) as Record<string, unknown>;
    const biRaw = (cfg.branchIsolation ?? {}) as Record<string, unknown>;
    const adapRaw = (pwRaw.adaptive ?? {}) as Record<string, unknown>;
    const rawTiers = Array.isArray(adapRaw.tiers) ? adapRaw.tiers as number[] : DEFAULT_TIERS;
    const rawLabels = Array.isArray(adapRaw.labels) ? adapRaw.labels as string[] : DEFAULT_LABELS;
    setParallel({
      max: typeof pwRaw.max === 'number' ? pwRaw.max : 1,
      mode: pwRaw.mode === 'competition' ? 'competition'
        : pwRaw.mode === 'adaptive' ? 'adaptive'
        : 'lane',
      workersPerFeature: typeof pwRaw.workersPerFeature === 'number' ? pwRaw.workersPerFeature : null,
      maxFeaturesInFlight: typeof pwRaw.maxFeaturesInFlight === 'number' ? pwRaw.maxFeaturesInFlight : null,
      useChunkLoop: pwRaw.useChunkLoop === true,
      workingStateCheck: typeof pwRaw.workingStateCheck === 'string' ? pwRaw.workingStateCheck : 'pnpm typecheck',
      replanStrikes: typeof pwRaw.replanStrikes === 'number' && pwRaw.replanStrikes > 0 ? pwRaw.replanStrikes : 3,
      escalateToRole: typeof pwRaw.escalateToRole === 'string' && pwRaw.escalateToRole.length > 0 ? pwRaw.escalateToRole : 'debugger',
      adaptive: {
        tiers: rawTiers.length >= 2 && rawTiers.length === rawLabels.length ? rawTiers : DEFAULT_TIERS,
        labels: rawTiers.length >= 2 && rawTiers.length === rawLabels.length ? rawLabels : DEFAULT_LABELS,
        rubric: typeof adapRaw.rubric === 'string' ? adapRaw.rubric : DEFAULT_RUBRIC,
      },
    });
    setBranchIso({
      enabled: biRaw.enabled === true,
      useWorktrees: biRaw.useWorktrees === true,
    });
    // aiBackend.{default, roles[role]} → flat row list
    const aiRaw = (cfg.aiBackend ?? {}) as Record<string, unknown>;
    const def = (aiRaw.default ?? {}) as Record<string, unknown>;
    const rolesObj = (aiRaw.roles ?? {}) as Record<string, Record<string, unknown>>;
    const rows: AiBackendRowCfg[] = [
      {
        role: '',
        agentCmd: typeof def.agentCmd === 'string' ? def.agentCmd : '',
        model: typeof def.model === 'string' ? def.model : '',
        extraArgsRaw: Array.isArray(def.extraArgs) ? (def.extraArgs as string[]).join(' ') : '',
      },
    ];
    for (const [role, rolCfg] of Object.entries(rolesObj)) {
      rows.push({
        role,
        agentCmd: typeof rolCfg.agentCmd === 'string' ? rolCfg.agentCmd : '',
        model: typeof rolCfg.model === 'string' ? rolCfg.model : '',
        extraArgsRaw: Array.isArray(rolCfg.extraArgs) ? (rolCfg.extraArgs as string[]).join(' ') : '',
      });
    }
    setAiBackend(rows);
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!Array.isArray(settingsConfigRows) || settingsConfigRows.length === 0) return;
    const cfgRaw = settingsConfigRows[0]?.config;
    if (typeof cfgRaw !== 'string' || !cfgRaw.trim()) { applyLoadedConfig({}); return; }
    try { applyLoadedConfig(JSON.parse(cfgRaw)); }
    catch { applyLoadedConfig({}); }
  }, [settingsConfigRows, applyLoadedConfig]);

  // REST back-stop: harnesses that pre-date the project-files mirror or
  // when Zero hasn't hydrated yet. Skipped once Zero has populated.
  useEffect(() => {
    if (loaded) return;
    let cancelled = false;
    fetch(`/api/harness/${slug}/spec?phase=${phase}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || loaded) return;
        const cfg = typeof data?.config === 'string' && data.config.trim()
          ? (() => { try { return JSON.parse(data.config); } catch { return {}; } })()
          : {};
        applyLoadedConfig(cfg);
      })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [slug, phase, loaded, applyLoadedConfig]);

  const refreshTelemetry = useCallback(async () => {
    setTelemetryLoading(true);
    try {
      const res = await fetch(`/api/harness/${slug}/orchestrator/adaptive-telemetry?limit=200`);
      const data = await res.json();
      setTelemetry(Array.isArray(data?.rows) ? data.rows : []);
    } catch {
      setTelemetry([]);
    } finally {
      setTelemetryLoading(false);
    }
  }, [slug]);

  // Auto-load telemetry only when adaptive mode is active.
  useEffect(() => {
    if (parallel.mode === 'adaptive') void refreshTelemetry();
  }, [parallel.mode, refreshTelemetry]);

  // Validation for adaptive tier shape — mirrors the old global API.
  const validation = useMemo(() => {
    if (parallel.mode !== 'adaptive') return { ok: true, msg: '' };
    const t = parallel.adaptive.tiers;
    const l = parallel.adaptive.labels;
    if (t.length < 2 || t.length > 5) return { ok: false, msg: 'Tiers must have 2-5 entries' };
    if (!t.every((n) => Number.isInteger(n) && n >= 1 && n <= 64)) {
      return { ok: false, msg: 'Tier values must be integers in [1, 64]' };
    }
    for (let i = 1; i < t.length; i++) {
      if (t[i] <= t[i - 1]) return { ok: false, msg: 'Tiers must be strictly ascending' };
    }
    if (l.length !== t.length) return { ok: false, msg: `Labels (${l.length}) must match tiers (${t.length})` };
    if (!l.every((s) => s.length > 0 && s.length <= 32)) {
      return { ok: false, msg: 'Labels must be non-empty and ≤32 characters' };
    }
    if (Buffer.byteLength?.(parallel.adaptive.rubric, 'utf8') > RUBRIC_MAX_BYTES) {
      return { ok: false, msg: `Rubric exceeds ${RUBRIC_MAX_BYTES} bytes` };
    }
    return { ok: true, msg: '' };
  }, [parallel]);

  const save = useCallback(async () => {
    if (!validation.ok) return;
    setSaving(true);
    try {
      // Merge into the existing spec config so we don't clobber unrelated keys.
      const cfg = { ...originalConfig } as Record<string, any>;
      const pw: Record<string, any> = { max: parallel.max, mode: parallel.mode };
      if (parallel.mode === 'competition' && parallel.workersPerFeature !== null) {
        pw.workersPerFeature = parallel.workersPerFeature;
      }
      if (parallel.maxFeaturesInFlight !== null) {
        pw.maxFeaturesInFlight = parallel.maxFeaturesInFlight;
      }
      // Chunk-loop knobs: only persist when they differ from the
      // defaults, to keep config files clean. The orchestrator
      // applies defaults if these fields are absent.
      if (parallel.useChunkLoop) {
        pw.useChunkLoop = true;
      }
      if (parallel.workingStateCheck && parallel.workingStateCheck !== 'pnpm typecheck') {
        pw.workingStateCheck = parallel.workingStateCheck;
      }
      if (parallel.replanStrikes !== 3) {
        pw.replanStrikes = parallel.replanStrikes;
      }
      if (parallel.escalateToRole && parallel.escalateToRole !== 'debugger') {
        pw.escalateToRole = parallel.escalateToRole;
      }
      if (parallel.mode === 'adaptive') {
        pw.adaptive = {
          tiers: parallel.adaptive.tiers,
          labels: parallel.adaptive.labels,
          rubric: parallel.adaptive.rubric,
        };
      }
      cfg.parallelWorkers = pw;

      // branchIso: forced-on at max>1; user-toggleable at max=1.
      const bi: Record<string, any> = { ...((cfg.branchIsolation as object) ?? {}) };
      if (parallel.max > 1) {
        bi.enabled = true;
        if (parallel.mode === 'competition' || parallel.mode === 'adaptive') {
          bi.useWorktrees = true;
        }
      } else {
        bi.enabled = branchIso.enabled;
      }
      cfg.branchIsolation = bi;

      // aiBackend: flatten rows back to {default, roles}. Empty fields
      // are dropped so unset rows don't pollute config.json.
      const aiOut: Record<string, unknown> = {};
      const rolesOut: Record<string, Record<string, unknown>> = {};
      for (const row of aiBackend) {
        const trimmedCmd = row.agentCmd.trim();
        const trimmedModel = row.model.trim();
        const extraArgs = row.extraArgsRaw.split(/\s+/).filter(Boolean);
        const slot: Record<string, unknown> = {};
        if (trimmedCmd) slot.agentCmd = trimmedCmd;
        if (trimmedModel) slot.model = trimmedModel;
        if (extraArgs.length > 0) slot.extraArgs = extraArgs;
        if (Object.keys(slot).length === 0) continue;
        if (row.role === '') {
          aiOut.default = slot;
        } else {
          rolesOut[row.role] = slot;
        }
      }
      if (Object.keys(rolesOut).length > 0) aiOut.roles = rolesOut;
      if (Object.keys(aiOut).length > 0) {
        cfg.aiBackend = aiOut;
      } else {
        delete cfg.aiBackend;
      }

      const res = await fetch(`/api/harness/${slug}/spec?phase=${phase}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: JSON.stringify(cfg, null, 2) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Settings saved');
      setOriginalConfig(cfg);
    } catch (e) {
      toast.error('Save failed', { description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [parallel, branchIso, originalConfig, slug, phase, validation.ok]);

  if (!loaded) {
    return <div style={{ padding: 24, color: 'var(--pc-muted, #9a9a9a)' }}>Loading…</div>;
  }

  const hasMaxAboveOne = parallel.max > 1;

  // ───── tier row helpers ─────
  const updateTier = (idx: number, value: string) => {
    const n = parseInt(value, 10);
    setParallel((p) => ({
      ...p,
      adaptive: {
        ...p.adaptive,
        tiers: p.adaptive.tiers.map((v, i) => (i === idx ? (Number.isFinite(n) ? n : v) : v)),
      },
    }));
  };
  const updateLabel = (idx: number, value: string) => {
    setParallel((p) => ({
      ...p,
      adaptive: {
        ...p.adaptive,
        labels: p.adaptive.labels.map((v, i) => (i === idx ? value : v)),
      },
    }));
  };
  const addTierRow = () => {
    setParallel((p) => {
      if (p.adaptive.tiers.length >= 5) return p;
      const last = p.adaptive.tiers[p.adaptive.tiers.length - 1] ?? 1;
      return {
        ...p,
        adaptive: {
          ...p.adaptive,
          tiers: [...p.adaptive.tiers, last + 2],
          labels: [...p.adaptive.labels, `tier-${p.adaptive.tiers.length + 1}`],
        },
      };
    });
  };
  const removeTierRow = (idx: number) => {
    setParallel((p) => {
      if (p.adaptive.tiers.length <= 2) return p;
      return {
        ...p,
        adaptive: {
          ...p.adaptive,
          tiers: p.adaptive.tiers.filter((_, i) => i !== idx),
          labels: p.adaptive.labels.filter((_, i) => i !== idx),
        },
      };
    });
  };

  // ───── telemetry table styles ─────
  const cellStyle: React.CSSProperties = {
    padding: '6px 10px',
    borderBottom: '1px solid var(--pc-border, #2a2a2a)',
    fontSize: 12,
    textAlign: 'left',
  };
  const headerStyle: React.CSSProperties = {
    ...cellStyle,
    color: 'var(--pc-muted, #9a9a9a)',
    fontWeight: 500,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  };

  return (
    <div style={{ padding: 16, maxWidth: 920, overflowY: 'auto' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Settings — {slug}</h1>
        <p style={{ margin: '6px 0 0', color: 'var(--pc-muted, #9a9a9a)', fontSize: 12.5 }}>
          Per-harness configuration. Saved to <code>{phase}</code> spec
          (<code>config.json</code>). Changes take effect on the next harness run.
        </p>
      </header>

      {/* ── Section 1: Parallel workers ─────────────────────── */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Parallel workers</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 80, fontSize: 11.5, color: 'var(--pc-muted, #9a9a9a)' }}>max</span>
            <input
              type="number"
              min={1}
              max={64}
              value={parallel.max}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                setParallel((p) => ({ ...p, max: Number.isFinite(n) ? n : 1 }));
              }}
              style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
            />
            <span style={{ fontSize: 11, color: 'var(--pc-muted, #9a9a9a)' }}>1-64</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 80, fontSize: 11.5, color: 'var(--pc-muted, #9a9a9a)' }}>mode</span>
            <select
              value={parallel.mode}
              onChange={(e) => setParallel((p) => ({ ...p, mode: e.target.value as Mode }))}
              style={{ fontSize: 12.5, padding: '3px 6px' }}
            >
              <option value="lane">lane (different features)</option>
              <option value="competition">competition (race per feature)</option>
              <option value="adaptive">adaptive (LLM picks per feature)</option>
            </select>
          </div>

          {parallel.mode === 'competition' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 80, fontSize: 11.5, color: 'var(--pc-muted, #9a9a9a)' }}>workers/feat</span>
              <input
                type="number"
                min={1}
                max={parallel.max}
                value={parallel.workersPerFeature ?? ''}
                placeholder={String(parallel.max)}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (v === '') {
                    setParallel((p) => ({ ...p, workersPerFeature: null }));
                  } else {
                    const n = parseInt(v, 10);
                    setParallel((p) => ({ ...p, workersPerFeature: Number.isFinite(n) ? n : null }));
                  }
                }}
                style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
              />
              <span style={{ fontSize: 11, color: 'var(--pc-muted, #9a9a9a)' }}>
                empty = all {parallel.max} on each feature
              </span>
            </div>
          )}

          {/* maxFeaturesInFlight — applies to every parallel mode. Caps
              the number of distinct features the orchestrator can have
              workers on at once, even if there are more worker slots
              free. Useful when you want to constrain "width" without
              reducing the total worker budget. Always shown — users
              may want to set it before bumping max. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 80, fontSize: 11.5, color: 'var(--pc-muted, #9a9a9a)' }}>features cap</span>
            <input
              type="number"
              min={1}
              value={parallel.maxFeaturesInFlight ?? ''}
              placeholder="no cap"
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === '') {
                  setParallel((p) => ({ ...p, maxFeaturesInFlight: null }));
                } else {
                  const n = parseInt(v, 10);
                  setParallel((p) => ({ ...p, maxFeaturesInFlight: Number.isFinite(n) && n > 0 ? n : null }));
                }
              }}
              style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
            />
            <span style={{ fontSize: 11, color: 'var(--pc-muted, #9a9a9a)' }}>
              {parallel.max > 1
                ? 'empty = unlimited (only worker slots limit)'
                : 'empty = unlimited (takes effect when max > 1)'}
            </span>
          </div>

          {/* ── Worker chunk loop knobs ───────────────────────────── */}
          <div style={{ marginTop: 6, paddingTop: 10, borderTop: '1px dashed var(--pc-border, #333)' }}>
            <div style={{ fontSize: 11.5, color: 'var(--pc-muted, #9a9a9a)', marginBottom: 6, fontStyle: 'italic' }}>
              Worker chunk loop (per-chunk file locks + L1 typecheck gate)
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, marginBottom: 8 }}>
              <input
                type="checkbox"
                checked={parallel.useChunkLoop}
                onChange={(e) => setParallel((p) => ({ ...p, useChunkLoop: e.target.checked }))}
              />
              <span>chunk loop enabled</span>
            </label>

            {parallel.useChunkLoop && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ width: 80, fontSize: 11.5, color: 'var(--pc-muted, #9a9a9a)' }}>typecheck</span>
                  <input
                    type="text"
                    value={parallel.workingStateCheck}
                    placeholder="pnpm typecheck"
                    onChange={(e) =>
                      setParallel((p) => ({ ...p, workingStateCheck: e.target.value }))
                    }
                    style={{ flex: 1, minWidth: 200, fontSize: 13, padding: '3px 6px', fontFamily: 'monospace' }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ width: 80, fontSize: 11.5, color: 'var(--pc-muted, #9a9a9a)' }}>strikes</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={parallel.replanStrikes}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (Number.isFinite(n) && n > 0) {
                        setParallel((p) => ({ ...p, replanStrikes: n }));
                      }
                    }}
                    style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--pc-muted, #9a9a9a)' }}>
                    typecheck failures before escalating
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 80, fontSize: 11.5, color: 'var(--pc-muted, #9a9a9a)' }}>escalate to</span>
                  <input
                    type="text"
                    value={parallel.escalateToRole}
                    placeholder="debugger"
                    onChange={(e) =>
                      setParallel((p) => ({ ...p, escalateToRole: e.target.value }))
                    }
                    style={{ width: 140, fontSize: 13, padding: '3px 6px', fontFamily: 'monospace' }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--pc-muted, #9a9a9a)' }}>
                    role taken over on N strikes
                  </span>
                </div>
              </>
            )}
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: hasMaxAboveOne ? 'var(--pc-muted, #9a9a9a)' : 'inherit' }}>
            <input
              type="checkbox"
              checked={hasMaxAboveOne ? true : branchIso.enabled}
              disabled={hasMaxAboveOne}
              onChange={(e) => setBranchIso((b) => ({ ...b, enabled: e.target.checked }))}
            />
            <span>branch isolation</span>
          </label>

          <div style={{ fontSize: 11.5, color: 'var(--pc-muted, #9a9a9a)', lineHeight: 1.5, marginTop: 4 }}>
            ↳{' '}
            {parallel.mode === 'lane' ? (
              <>up to <strong>{parallel.max}</strong> different feature{parallel.max === 1 ? '' : 's'} in parallel, 1 worker each</>
            ) : parallel.mode === 'competition' ? (
              (() => {
                const wpf = parallel.workersPerFeature ?? parallel.max;
                const inFlight = Math.max(1, Math.floor(parallel.max / wpf));
                return (
                  <>
                    <strong>{wpf}</strong> worker{wpf === 1 ? '' : 's'}/feature racing,{' '}
                    <strong>{inFlight}</strong> feature{inFlight === 1 ? '' : 's'} in flight (max {parallel.max})
                  </>
                );
              })()
            ) : (
              <>
                orchestrator picks N per feature from{' '}
                <strong>{`{${parallel.adaptive.tiers.join(', ')}}`}</strong> (max {parallel.max})
              </>
            )}
            {hasMaxAboveOne && (
              <>; branchIso auto-on{(parallel.mode === 'competition' || parallel.mode === 'adaptive') && ' + worktrees'}</>
            )}
          </div>
        </div>
      </section>

      {/* ── Section 2: Adaptive tiers ───────────────────────── */}
      {parallel.mode === 'adaptive' && (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Adaptive worker tiers</h2>
          <p style={{ margin: '0 0 8px', color: 'var(--pc-muted, #9a9a9a)', fontSize: 11.5 }}>
            2–5 ascending integer tiers. Lowest tier acts as the fallback when the orchestrator
            omits <code>N=</code> from its decision. Saved to this harness's spec.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {parallel.adaptive.tiers.map((value, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ width: 60, fontSize: 11, color: 'var(--pc-muted, #9a9a9a)' }}>
                  Tier {idx + 1}
                </span>
                <input
                  type="number"
                  min={1}
                  max={64}
                  value={value}
                  onChange={(e) => updateTier(idx, e.target.value)}
                  style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
                />
                <span style={{ fontSize: 11, color: 'var(--pc-muted, #9a9a9a)' }}>workers</span>
                <input
                  type="text"
                  value={parallel.adaptive.labels[idx] ?? ''}
                  onChange={(e) => updateLabel(idx, e.target.value)}
                  placeholder="label"
                  maxLength={32}
                  style={{ width: 140, fontSize: 13, padding: '3px 6px' }}
                />
                <button
                  type="button"
                  onClick={() => removeTierRow(idx)}
                  disabled={parallel.adaptive.tiers.length <= 2}
                  title={parallel.adaptive.tiers.length <= 2 ? 'Need at least 2 tiers' : 'Remove row'}
                  style={{ fontSize: 11, padding: '2px 8px' }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addTierRow}
              disabled={parallel.adaptive.tiers.length >= 5}
              style={{ alignSelf: 'flex-start', fontSize: 11, padding: '3px 10px', marginTop: 4 }}
            >
              + Add tier
            </button>
          </div>

          <h3 style={{ fontSize: 13, margin: '16px 0 6px' }}>Difficulty rubric</h3>
          <p style={{ margin: '0 0 8px', color: 'var(--pc-muted, #9a9a9a)', fontSize: 11.5 }}>
            Appended to the orchestrator prompt when this harness runs in adaptive mode.
          </p>
          <textarea
            value={parallel.adaptive.rubric}
            onChange={(e) => setParallel((p) => ({ ...p, adaptive: { ...p.adaptive, rubric: e.target.value } }))}
            placeholder={DEFAULT_RUBRIC}
            rows={6}
            style={{
              width: '100%', fontSize: 12, padding: 8, fontFamily: 'monospace',
              background: 'var(--pc-card-bg, #141414)',
              border: '1px solid var(--pc-border, #2a2a2a)', borderRadius: 4,
              color: 'inherit',
            }}
          />
        </section>
      )}

      {/* ── Section 2.5: AI backend (per-harness default + per-role overrides) ─ */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>AI backend</h2>
        <p style={{ margin: '0 0 8px', color: 'var(--pc-muted, #9a9a9a)', fontSize: 11.5 }}>
          Default agent command + per-role overrides. Resolution at invoke
          time: <code>roles[role]</code> ⊕ <code>default</code> ⊕ process env
          (<code>AGENT_CMD</code>). Leave blank to fall through. Common
          values: <code>omp -p</code>, <code>claude -p</code>,
          <code>omp -p --model claude-sonnet-4-6</code>.
        </p>
        <p style={{ margin: '0 0 8px', color: 'var(--bad, #d97757)', fontSize: 11.5 }}>
          ⚠ Do not put API keys here — config.json is plaintext. Set secrets
          in the shell environment for now.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {aiBackend.map((row, idx) => {
            const isDefault = row.role === '';
            const usedRoles = new Set(aiBackend.filter((_, i) => i !== idx).map((r) => r.role));
            const availableRoles = KNOWN_ROLES.filter((r) => !usedRoles.has(r));
            return (
              <div
                key={idx}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '140px 1fr 160px 200px 32px',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                {isDefault ? (
                  <div style={{ fontSize: 12, color: 'var(--pc-muted, #9a9a9a)', fontWeight: 500 }}>
                    default (all roles)
                  </div>
                ) : (
                  <input
                    type="text"
                    list={`ai-roles-${idx}`}
                    value={row.role}
                    placeholder="role"
                    onChange={(e) => {
                      const v = e.target.value;
                      setAiBackend((rows) => rows.map((r, i) => (i === idx ? { ...r, role: v } : r)));
                    }}
                    style={{ fontSize: 12, padding: '3px 6px' }}
                  />
                )}
                <input
                  type="text"
                  value={row.agentCmd}
                  placeholder={isDefault ? 'omp -p' : '(inherits default)'}
                  onChange={(e) => {
                    const v = e.target.value;
                    setAiBackend((rows) => rows.map((r, i) => (i === idx ? { ...r, agentCmd: v } : r)));
                  }}
                  style={{ fontSize: 12, padding: '3px 6px', fontFamily: 'monospace' }}
                />
                <input
                  type="text"
                  value={row.model}
                  placeholder="model (optional)"
                  onChange={(e) => {
                    const v = e.target.value;
                    setAiBackend((rows) => rows.map((r, i) => (i === idx ? { ...r, model: v } : r)));
                  }}
                  style={{ fontSize: 12, padding: '3px 6px', fontFamily: 'monospace' }}
                />
                <input
                  type="text"
                  value={row.extraArgsRaw}
                  placeholder="extra args (whitespace-split)"
                  onChange={(e) => {
                    const v = e.target.value;
                    setAiBackend((rows) => rows.map((r, i) => (i === idx ? { ...r, extraArgsRaw: v } : r)));
                  }}
                  style={{ fontSize: 12, padding: '3px 6px', fontFamily: 'monospace' }}
                />
                {isDefault ? (
                  <span />
                ) : (
                  <button
                    type="button"
                    onClick={() => setAiBackend((rows) => rows.filter((_, i) => i !== idx))}
                    title="Remove role override"
                    style={{ fontSize: 11, padding: '2px 6px' }}
                  >
                    ✕
                  </button>
                )}
                {!isDefault && (
                  <datalist id={`ai-roles-${idx}`}>
                    {availableRoles.map((r) => (
                      <option key={r} value={r} />
                    ))}
                  </datalist>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => {
              const used = new Set(aiBackend.map((r) => r.role));
              const next = KNOWN_ROLES.find((r) => !used.has(r)) ?? '';
              setAiBackend((rows) => [...rows, { role: next, agentCmd: '', model: '', extraArgsRaw: '' }]);
            }}
            style={{ alignSelf: 'flex-start', fontSize: 11, padding: '3px 10px', marginTop: 4 }}
          >
            + Add role override
          </button>
        </div>
      </section>

      {/* ── Save bar ────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!validation.ok || saving}
          style={{
            fontSize: 13, padding: '6px 18px',
            cursor: !validation.ok || saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {!validation.ok && (
          <span style={{ fontSize: 11.5, color: 'var(--bad, #d97757)' }}>⚠ {validation.msg}</span>
        )}
      </div>

      {/* ── Section 3: Telemetry (adaptive mode only) ───────── */}
      {parallel.mode === 'adaptive' && (
        <section>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ fontSize: 14, margin: 0 }}>Recent allocations</h2>
            <button
              type="button"
              onClick={() => void refreshTelemetry()}
              disabled={telemetryLoading}
              style={{ fontSize: 11, padding: '3px 10px' }}
            >
              {telemetryLoading ? '…' : 'Refresh'}
            </button>
          </div>
          {telemetry.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--pc-muted, #9a9a9a)', fontSize: 12 }}>
              No adaptive-mode decisions recorded yet. Run the harness in adaptive mode to populate.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid var(--pc-border, #2a2a2a)', borderRadius: 4 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={headerStyle}>When</th>
                    <th style={headerStyle}>Feature</th>
                    <th style={headerStyle}>N</th>
                    <th style={headerStyle}>Tier</th>
                    <th style={headerStyle}>Slots</th>
                    <th style={headerStyle}>Outcome</th>
                    <th style={headerStyle}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {telemetry.map((row) => {
                    const when = new Date(row.ts).toLocaleString();
                    const nDisplay = row.requested_n === row.actual_n
                      ? `${row.actual_n}`
                      : `${row.actual_n} (req ${row.requested_n})`;
                    const slots = row.max_slots != null && row.available_at_decision != null
                      ? `${row.available_at_decision}/${row.max_slots}`
                      : '—';
                    const outcomeColor = row.outcome === 'pass'
                      ? 'var(--good, #6aa84f)'
                      : row.outcome === 'fail'
                      ? 'var(--bad, #d97757)'
                      : 'var(--pc-muted, #9a9a9a)';
                    const duration = row.duration_ms != null ? `${(row.duration_ms / 1000).toFixed(1)}s` : '—';
                    return (
                      <tr key={row.id}>
                        <td style={cellStyle}>{when}</td>
                        <td style={cellStyle}>{row.feature_id}</td>
                        <td style={cellStyle}>{nDisplay}</td>
                        <td style={cellStyle}>{row.tier_label ?? '—'}</td>
                        <td style={cellStyle}>{slots}</td>
                        <td style={{ ...cellStyle, color: outcomeColor }}>{row.outcome ?? 'pending'}</td>
                        <td style={cellStyle}>{duration}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
