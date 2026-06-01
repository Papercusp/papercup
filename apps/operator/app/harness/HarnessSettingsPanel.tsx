'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useSyncQuery } from '@papercusp/sync';
import { Checkbox } from './Checkbox';

/**
 * Per-harness Settings panel — one tab inside the harness UI.
 *
 * All controls live per-harness in the spec (`config.json` →
 * parallelWorkers.* / debugger.*) so each harness can carry its own
 * chunk-loop + worker configuration.
 *
 * Each feature gets one chunk-loop worker; `parallelWorkers.max` is the
 * cross-feature concurrency. The competition / adaptive-tier /
 * synthesizer / branch-isolation lane model is deprecated and its
 * controls have been removed.
 *
 * Sections:
 *   1. Workers — max, chunk-loop knobs, debugger threshold.
 *   2. AI backend — per-harness default + per-role overrides.
 *   3. Discord.
 */

interface ParallelWorkersCfg {
  max: number;
  /** Feature flag for the new worker chunk loop (atomic file locks,
   *  per-chunk typecheck gate, replan + escalate). */
  useChunkLoop: boolean;
  /** L1 typecheck command run after each chunk's edits. */
  workingStateCheck: string;
  /** Number of typecheck-rejection retries before escalating. */
  replanStrikes: number;
  /** Agent role taken over on chunk escalation. */
  escalateToRole: string;
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
  'synthesizer',
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

interface DiscordSettings {
  isShared: boolean;
  guildId: string;
  inviteUrl: string;
  saving: boolean;
  saved: boolean;
  error: string | null;
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
    useChunkLoop: true,
    workingStateCheck: 'pnpm typecheck',
    replanStrikes: 3,
    escalateToRole: 'debugger',
  });
  /** `debugger.threshold` — attempts at which the debugger role auto-fires before workers. */
  const [debuggerThreshold, setDebuggerThreshold] = useState<number>(3);
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

  const [discord, setDiscord] = useState<DiscordSettings>({
    isShared: false,
    guildId: '',
    inviteUrl: '',
    saving: false,
    saved: false,
    error: null,
  });

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
    const dbgRaw = (cfg.debugger ?? {}) as Record<string, unknown>;
    const max = typeof pwRaw.max === 'number' ? pwRaw.max : 1;

    setParallel({
      max,
      // Default is true (matches orchestrator's useChunkLoop()).
      useChunkLoop: pwRaw.useChunkLoop === undefined ? true : pwRaw.useChunkLoop === true,
      workingStateCheck: typeof pwRaw.workingStateCheck === 'string' ? pwRaw.workingStateCheck : 'pnpm typecheck',
      replanStrikes: typeof pwRaw.replanStrikes === 'number' && pwRaw.replanStrikes > 0 ? pwRaw.replanStrikes : 3,
      escalateToRole: typeof pwRaw.escalateToRole === 'string' && pwRaw.escalateToRole.length > 0 ? pwRaw.escalateToRole : 'debugger',
    });
    setDebuggerThreshold(
      typeof dbgRaw.threshold === 'number' && dbgRaw.threshold > 0
        ? Math.floor(dbgRaw.threshold)
        : 3,
    );
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

  // Load discord config from the dedicated endpoint (also gives us isShared).
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/harness/${slug}/discord`)
      .then((r) => r.json())
      .then((d: { isShared?: boolean; discord?: { guildId?: string; inviteUrl?: string } | null }) => {
        if (cancelled) return;
        setDiscord((prev) => ({
          ...prev,
          isShared: d.isShared === true,
          guildId: d.discord?.guildId ?? '',
          inviteUrl: d.discord?.inviteUrl ?? '',
        }));
      })
      .catch(() => { /* not critical */ });
    return () => { cancelled = true; };
  }, [slug]);

  const saveDiscord = useCallback(async () => {
    setDiscord((prev) => ({ ...prev, saving: true, error: null, saved: false }));
    try {
      const res = await fetch(`/api/harness/${slug}/discord`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ guildId: discord.guildId.trim(), inviteUrl: discord.inviteUrl.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setDiscord((prev) => ({ ...prev, saving: false, saved: true }));
      toast.success('Discord settings saved');
    } catch (e) {
      setDiscord((prev) => ({ ...prev, saving: false, error: (e as Error).message }));
      toast.error('Failed to save Discord settings', { description: (e as Error).message });
    }
  }, [slug, discord.guildId, discord.inviteUrl]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      // Merge into the existing spec config so we don't clobber unrelated keys.
      const cfg = { ...originalConfig } as Record<string, any>;

      // Each feature gets one chunk-loop worker; `max` is the
      // cross-feature concurrency.
      const pw: Record<string, any> = { max: parallel.max };

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
      cfg.parallelWorkers = pw;

      // debugger.threshold: persist only when not the default (3).
      const dbg: Record<string, any> = { ...((cfg.debugger as object) ?? {}) };
      if (debuggerThreshold !== 3) {
        dbg.threshold = debuggerThreshold;
        cfg.debugger = dbg;
      } else if ('threshold' in dbg) {
        delete dbg.threshold;
        if (Object.keys(dbg).length === 0) {
          delete cfg.debugger;
        } else {
          cfg.debugger = dbg;
        }
      }

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
  }, [parallel, debuggerThreshold, aiBackend, originalConfig, slug, phase]);

  if (!loaded) {
    return <div style={{ padding: 24, color: 'var(--fg-mute)' }}>Loading…</div>;
  }

  return (
    <div style={{ padding: 16, maxWidth: 920, overflowY: 'auto' }}>
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Settings — {slug}</h1>
        <p style={{ margin: '6px 0 0', color: 'var(--fg-mute)', fontSize: 12.5 }}>
          Per-harness configuration. Saved to <code>{phase}</code> spec
          (<code>config.json</code>). Changes take effect on the next harness run.
        </p>
      </header>

      {/* ── Section 1: Workers ──────────────────────────────── */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>Workers</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 110, fontSize: 11.5, color: 'var(--fg-mute)' }}>max workers</span>
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
            <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>1-64 total concurrent</span>
          </div>

          {/* ── Worker chunk loop knobs ───────────────────────────── */}
          <div style={{ marginTop: 6, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
            <div style={{ fontSize: 11.5, color: 'var(--fg-mute)', marginBottom: 6, fontStyle: 'italic' }}>
              Worker chunk loop (per-chunk file locks + L1 typecheck gate)
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, marginBottom: 8 }}>
              <Checkbox
                checked={parallel.useChunkLoop}
                onChange={(v) => setParallel((p) => ({ ...p, useChunkLoop: v }))}
                ariaLabel="chunk loop enabled"
              />
              <span>chunk loop enabled</span>
            </label>

            {parallel.useChunkLoop && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{ width: 80, fontSize: 11.5, color: 'var(--fg-mute)' }}>typecheck</span>
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
                  <span style={{ width: 80, fontSize: 11.5, color: 'var(--fg-mute)' }}>strikes</span>
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
                  <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                    typecheck failures before escalating
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 80, fontSize: 11.5, color: 'var(--fg-mute)' }}>escalate to</span>
                  <input
                    type="text"
                    value={parallel.escalateToRole}
                    placeholder="debugger"
                    onChange={(e) =>
                      setParallel((p) => ({ ...p, escalateToRole: e.target.value }))
                    }
                    style={{ width: 140, fontSize: 13, padding: '3px 6px', fontFamily: 'monospace' }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
                    role taken over on N strikes
                  </span>
                </div>
              </>
            )}
          </div>

          {/* ── Debugger threshold ──────────────────────────────── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
            <span style={{ width: 110, fontSize: 11.5, color: 'var(--fg-mute)' }}>debugger after</span>
            <input
              type="number"
              min={1}
              max={20}
              value={debuggerThreshold}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n) && n > 0) setDebuggerThreshold(n);
              }}
              style={{ width: 64, fontSize: 13, padding: '3px 6px' }}
            />
            <span style={{ fontSize: 11, color: 'var(--fg-mute)' }}>
              attempts (debugger auto-fires before worker)
            </span>
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--fg-mute)', lineHeight: 1.5, marginTop: 4 }}>
            ↳ up to <strong>{parallel.max}</strong> feature{parallel.max === 1 ? '' : 's'} in parallel, one chunk-loop worker each.
          </div>
        </div>
      </section>

      {/* ── Section 2.5: AI backend (per-harness default + per-role overrides) ─ */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, margin: '0 0 8px' }}>AI backend</h2>
        <p style={{ margin: '0 0 8px', color: 'var(--fg-mute)', fontSize: 11.5 }}>
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
                  <div style={{ fontSize: 12, color: 'var(--fg-mute)', fontWeight: 500 }}>
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

      {/* ── Section: Discord ────────────────────────────────── */}
      <section style={{ marginBottom: 24, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
        <h2 style={{ fontSize: 14, margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#5865F2', flexShrink: 0 }} aria-hidden>
            <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.031.056a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
          </svg>
          Discord
        </h2>
        {!discord.isShared ? (
          <p style={{ margin: 0, color: 'var(--fg-mute)', fontSize: 11.5, fontStyle: 'italic' }}>
            Discord integration is only available for shared harnesses. Use the Share button to publish this harness first.
          </p>
        ) : (
          <>
            <p style={{ margin: '0 0 12px', color: 'var(--fg-mute)', fontSize: 11.5 }}>
              Link a Discord server to show a live online-count badge in the /adv navbar.
              Requires the Discord server widget to be enabled in Server Settings → Widget.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 540 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ width: 90, fontSize: 11.5, color: 'var(--fg-mute)', flexShrink: 0 }}>Guild ID</label>
                <input
                  type="text"
                  value={discord.guildId}
                  onChange={(e) => setDiscord((prev) => ({ ...prev, guildId: e.target.value, saved: false }))}
                  placeholder="e.g. 1509111829471690783"
                  style={{ flex: 1, fontSize: 12, padding: '4px 8px', fontFamily: 'monospace' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ width: 90, fontSize: 11.5, color: 'var(--fg-mute)', flexShrink: 0 }}>Invite URL</label>
                <input
                  type="text"
                  value={discord.inviteUrl}
                  onChange={(e) => setDiscord((prev) => ({ ...prev, inviteUrl: e.target.value, saved: false }))}
                  placeholder="https://discord.gg/…"
                  style={{ flex: 1, fontSize: 12, padding: '4px 8px' }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => void saveDiscord()}
                  disabled={discord.saving || !discord.guildId.trim()}
                  style={{ fontSize: 12, padding: '5px 14px', cursor: discord.saving || !discord.guildId.trim() ? 'not-allowed' : 'pointer' }}
                >
                  {discord.saving ? 'Saving…' : 'Save Discord'}
                </button>
                {discord.saved && (
                  <span style={{ fontSize: 11.5, color: 'var(--good, #6aa84f)' }}>✓ Saved</span>
                )}
                {discord.error && (
                  <span style={{ fontSize: 11.5, color: 'var(--bad, #d97757)' }}>⚠ {discord.error}</span>
                )}
              </div>
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--fg-mute)', lineHeight: 1.5 }}>
                To enable the widget: Discord → Server Settings → Widget → Enable Server Widget.
                The Guild ID is shown there too. The badge refreshes every 5 minutes.
              </p>
            </div>
          </>
        )}
      </section>

      {/* ── Save bar ────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          style={{
            fontSize: 13, padding: '6px 18px',
            cursor: saving ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
