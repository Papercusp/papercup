'use client';

/**
 * Agent backend settings — pick which CLI (claude-code or omp) the
 * operator + harness drive, override the binary if needed, set per-role
 * model defaults, and define the model-tier menu per-task picks resolve
 * against (queen-model-tier-selection-2026-06-11).
 *
 * PER-FIELD AUTO-SAVE (owner ask 2026-06-11): every control persists
 * automatically (debounced) — there is no Save button. This is the canonical
 * macOS-System-Preferences settings shape (design libraries §form-patterns;
 * voice/backups/operator are the sibling sites). Invalid rows (bad model
 * spec, duplicate tier name) are EXCLUDED from the saved config and flagged
 * inline — they never block the rest of the page from saving.
 *
 * Persisted via POST /api/agent-config (PG operator_agent_config). Changes
 * take effect for in-process spawns immediately (the route mirrors into
 * process.env; empty values restore the host's boot env — EI-337).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useDebouncedSave } from '../../harness/useDebouncedSave';
import { FormField } from '@/lib/forms';
import { Select } from '../../harness/Select';
import {
  AGENT_BACKENDS,
  DEFAULT_MODEL_TIERS,
  SURFACE_KEYS,
  isValidModelSpec,
  type AgentBackend,
  type ModelTier,
  type SurfaceKey,
} from '@papercusp/operator-core/lib/agent-config-constants';

/** Options for a backend pick that may also inherit (per-surface, per-tier). */
const BACKEND_CHOICE_OPTIONS = [
  { value: 'inherit', label: 'Inherit global' },
  ...AGENT_BACKENDS.map((b) => ({ value: b, label: b })),
];

/** Local select value: a concrete backend, or 'inherit' = omit from the map. */
type SurfaceChoice = 'inherit' | AgentBackend;

type GlobalBackend = 'auto' | AgentBackend;

interface AgentConfig {
  backend: GlobalBackend;
  cmd: string;
  models: Record<string, string>;
  backends?: Partial<Record<SurfaceKey, AgentBackend>>;
  surfaceModels?: Partial<Record<SurfaceKey, string>>;
  tiers?: ModelTier[];
  tierCeilings?: Record<string, string>;
}
interface DetectedBinaries {
  claude: string | null;
  omp: string | null;
  pi: string | null;
}
interface ConfigSnapshot {
  config: AgentConfig;
  binaries: DetectedBinaries;
  effectiveBackend: AgentBackend;
  envOverrides: { AGENT_BACKEND: string | null; AGENT_CMD: string | null; CLAUDE_CMD: string | null };
}

interface TestResult {
  ok: boolean;
  finalText: string;
  durationMs: number;
  costUsd: number;
  error: string | null;
}

const ROLE_HINTS = ['operator', 'orchestrator', 'scoper', 'worker', 'validator', 'reviewer', 'debugger', 'curator', 'documenter', 'architect', 'planner'];

/** Roles offered a tier-ceiling row — the spawn-heavy fleet roles where the
    queen's per-task tier pick applies (others can be added via the JSON). */
const CEILING_ROLES = ['bee', 'worker', 'validator', 'scoper', 'reviewer', 'scanner', 'judge'];

/** The claude CLI's bare model aliases (verified against the installed CLI
    2026-06-11: `claude -p --model <x>` — `fable5`/`opush` are rejected).
    Used for a SOFT typo warning only: full ids (claude-opus-4-8), provider
    ids (anthropic/…, gpt-5.5) and other backends' ids are always allowed. */
const KNOWN_CLAUDE_ALIASES = new Set(['haiku', 'sonnet', 'opus', 'fable']);

/** Model-id half of a `<modelId>[:<effort>]` spec. */
function specId(spec: string): string {
  const lastColon = spec.lastIndexOf(':');
  if (lastColon <= 0) return spec;
  const suffix = spec.slice(lastColon + 1);
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(suffix) ? spec.slice(0, lastColon) : spec;
}

/** Soft typo check: a bare lowercase word that isn't a known claude alias is
    almost always a misspelling (opush, fable5). Anything with -, /, or . is
    a full/provider id and never flagged. */
function aliasWarning(spec: string): string | null {
  const id = specId(spec.trim());
  if (!/^[a-z][a-z0-9]*$/.test(id)) return null;
  if (KNOWN_CLAUDE_ALIASES.has(id)) return null;
  return `"${id}" is not a known claude alias (haiku · sonnet · opus · fable) — full model ids like claude-opus-4-8 are also fine`;
}

/** Mid-edit tier rows (drafts, so plain useState like the other form fields).
    `backend: ''` = inherit the global agent command. */
interface TierRow {
  name: string;
  spec: string;
  backend: '' | AgentBackend;
  /** When the queen should pick this tier — injected into her launch prompt. */
  when: string;
}

const tierToRow = (t: ModelTier): TierRow => ({ name: t.name, spec: t.spec, backend: t.backend ?? '', when: t.when ?? '' });

export default function AgentSettingsPage() {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [backend, setBackend] = useState<GlobalBackend>('omp');
  const [cmd, setCmd] = useState('');
  const [modelsJson, setModelsJson] = useState('');
  // Per-surface backend overrides. 'inherit' means "omit from the map" (use
  // the global backend above). Mid-edit draft, so plain useState rather than
  // nuqs — it's wiped on reload from the fetched config like the other fields.
  const [surfaceBackends, setSurfaceBackends] = useState<Record<SurfaceKey, SurfaceChoice>>(
    () => Object.fromEntries(SURFACE_KEYS.map((k) => [k, 'inherit'])) as Record<SurfaceKey, SurfaceChoice>,
  );
  // Per-surface model overrides (OQ3 companion to surfaceBackends). '' = inherit
  // the surface's own default model.
  const [surfaceModels, setSurfaceModels] = useState<Record<SurfaceKey, string>>(
    () => Object.fromEntries(SURFACE_KEYS.map((k) => [k, ''])) as Record<SurfaceKey, string>,
  );
  // Model-tier menu rows, ordered weakest → strongest (the order IS the
  // strength ranking the spawn clamp uses). Empty list = the committed
  // defaults apply at resolution time; the editor seeds them for visibility.
  const [tierRows, setTierRows] = useState<TierRow[]>(DEFAULT_MODEL_TIERS.map(tierToRow));
  const [tiersCustomized, setTiersCustomized] = useState(false);
  // Per-role ceiling: '' = no ceiling (strongest tier allowed).
  const [tierCeilings, setTierCeilings] = useState<Record<string, string>>({});

  // Auto-save plumbing: the last server-acknowledged config (stringified) —
  // hydration echoes and no-op edits compare equal and skip the POST.
  const lastSavedRef = useRef<string | null>(null);
  // Last VALID parsed models map — an in-progress (invalid) JSON edit keeps
  // saving the previous valid map instead of blocking the page.
  const lastValidModelsRef = useRef<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-config');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as ConfigSnapshot;
      setSnapshot(d);
      setBackend(d.config.backend);
      setCmd(d.config.cmd);
      lastValidModelsRef.current = d.config.models ?? {};
      setModelsJson(Object.keys(d.config.models).length > 0 ? JSON.stringify(d.config.models, null, 2) : '');
      const fetched = d.config.backends ?? {};
      setSurfaceBackends(
        Object.fromEntries(SURFACE_KEYS.map((k) => [k, fetched[k] ?? 'inherit'])) as Record<SurfaceKey, SurfaceChoice>,
      );
      const fetchedModels = d.config.surfaceModels ?? {};
      setSurfaceModels(
        Object.fromEntries(SURFACE_KEYS.map((k) => [k, fetchedModels[k] ?? ''])) as Record<SurfaceKey, string>,
      );
      const fetchedTiers = d.config.tiers ?? [];
      setTiersCustomized(fetchedTiers.length > 0);
      setTierRows((fetchedTiers.length > 0 ? fetchedTiers : DEFAULT_MODEL_TIERS).map(tierToRow));
      setTierCeilings(d.config.tierCeilings ?? {});
    } catch (err) {
      toast.error(`load failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ── Assemble the persistable config + inline problems ──────────────────────
  // Invalid pieces are EXCLUDED from the save (and flagged inline) so one bad
  // row never blocks the rest of the page from persisting.
  const { persistable, problems, warnings } = useMemo(() => {
    const problems: string[] = [];
    const warnings: string[] = [];

    let models = lastValidModelsRef.current;
    if (modelsJson.trim()) {
      try {
        const parsed = JSON.parse(modelsJson) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('must be a JSON object of { role: model }');
        }
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v !== 'string') throw new Error(`"${k}" must map to a string model id`);
          next[k] = v;
        }
        models = next;
        lastValidModelsRef.current = next;
      } catch (err) {
        problems.push(`per-role models JSON not saved: ${(err as Error).message}`);
      }
    } else {
      models = {};
      lastValidModelsRef.current = {};
    }

    const backends: Partial<Record<SurfaceKey, AgentBackend>> = {};
    const surfaceModelsOut: Partial<Record<SurfaceKey, string>> = {};
    for (const k of SURFACE_KEYS) {
      const choice = surfaceBackends[k];
      if (choice !== 'inherit') backends[k] = choice;
      const m = surfaceModels[k]?.trim();
      if (m) surfaceModelsOut[k] = m;
    }

    const cleanedTiers: ModelTier[] = [];
    const seenNames = new Set<string>();
    for (const [i, row] of tierRows.entries()) {
      const name = row.name.trim();
      const spec = row.spec.trim();
      if (!name && !spec) continue; // blank row — ignored
      if (!name || !spec) {
        problems.push(`tier row ${i + 1} not saved: needs both a name and a model spec`);
        continue;
      }
      if (seenNames.has(name.toLowerCase())) {
        problems.push(`tier row ${i + 1} not saved: duplicate name "${name}"`);
        continue;
      }
      if (!isValidModelSpec(spec)) {
        problems.push(`tier "${name}" not saved: invalid spec "${spec}" (shape: <modelId>[:<effort>], no spaces)`);
        continue;
      }
      const warn = aliasWarning(spec);
      if (warn) warnings.push(`tier "${name}": ${warn}`);
      seenNames.add(name.toLowerCase());
      cleanedTiers.push({
        name,
        spec,
        ...(row.backend ? { backend: row.backend } : {}),
        ...(row.when.trim() ? { when: row.when.trim() } : {}),
      });
    }
    // Store [] when the rows still equal the committed defaults — an untouched
    // menu keeps tracking future default changes instead of freezing a copy.
    const isDefaultMenu = JSON.stringify(cleanedTiers) === JSON.stringify(DEFAULT_MODEL_TIERS);
    const tiersOut = isDefaultMenu ? [] : cleanedTiers;

    const ceilingsOut: Record<string, string> = {};
    for (const [role, tier] of Object.entries(tierCeilings)) {
      if (!tier) continue;
      if (!seenNames.has(tier.toLowerCase())) {
        problems.push(`ceiling for "${role}" not saved: names unknown tier "${tier}"`);
        continue;
      }
      ceilingsOut[role] = tier;
    }

    const persistable: AgentConfig = {
      backend,
      cmd,
      models,
      backends,
      surfaceModels: surfaceModelsOut,
      tiers: tiersOut,
      tierCeilings: ceilingsOut,
    };
    return { persistable, problems, warnings };
  }, [backend, cmd, modelsJson, surfaceBackends, surfaceModels, tierRows, tierCeilings]);

  const hydrated = !loading && snapshot != null;
  const { saving, lastSavedAt } = useDebouncedSave(
    hydrated ? persistable : null,
    async (v) => {
      if (v == null) return;
      const body = JSON.stringify(v);
      // Hydration echo / no-op edit — nothing changed since the last ack.
      if (lastSavedRef.current === body) return;
      const r = await fetch('/api/agent-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      lastSavedRef.current = body;
    },
    {
      ms: 600,
      onError: (err) => toast.error(`auto-save failed: ${(err as Error).message}`),
    },
  );
  // Seed the no-op guard with the server's view once hydrated.
  useEffect(() => {
    if (hydrated && lastSavedRef.current == null) {
      lastSavedRef.current = JSON.stringify(persistable);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch('/api/agent-config/test', { method: 'POST' });
      const d = (await r.json()) as TestResult;
      setTestResult(d);
      if (d.ok) toast.success(`Backend OK (${d.durationMs}ms, ${d.finalText.slice(0, 40)})`);
      else toast.error(`Test failed: ${d.error ?? 'no output'}`);
    } catch (err) {
      toast.error(`test request failed: ${(err as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <div><h1>AI backend</h1><p className="pc-settings-loading">Loading…</p></div>;
  if (!snapshot) return <div><h1>AI backend</h1><p style={{ color: 'var(--bad)' }}>Failed to load config.</p></div>;

  const { binaries, effectiveBackend, envOverrides } = snapshot;
  const defaultCmd = backend === 'omp' || backend === 'auto' ? 'omp -p' : backend === 'codex' ? 'codex exec' : 'claude -p';

  return (
    <div>
      <h1 style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        AI backend
        <span style={{ fontSize: 12, fontWeight: 400, color: saving ? 'var(--accent)' : 'var(--fg-mute)' }}>
          {saving
            ? 'Saving…'
            : lastSavedAt
              ? `✓ Saved ${lastSavedAt.toLocaleTimeString()}`
              : 'Changes save automatically'}
        </span>
      </h1>
      <p className="pc-settings-intro">
        Which agent CLI the operator and harness drive. Two backends are
        supported: <code>claude-code</code> (Anthropic <code>claude</code>)
        and <code>omp</code> (<a
          href="https://github.com/can1357/oh-my-pi"
          target="_blank"
          rel="noreferrer"
          style={{ color: 'var(--accent)' }}
        >oh-my-pi</a>) — the multi-provider option. Every change on this page
        saves automatically.
      </p>

      {(problems.length > 0 || warnings.length > 0) && (
        <section className="pc-card" style={{ padding: 12, marginTop: 12, borderColor: problems.length > 0 ? 'var(--bad)' : 'var(--warn, #b58900)' }}>
          {problems.map((p, i) => (
            <div key={`p${i}`} style={{ fontSize: 12, color: 'var(--bad)' }}>✗ {p}</div>
          ))}
          {warnings.map((w, i) => (
            <div key={`w${i}`} style={{ fontSize: 12, color: 'var(--warn, #b58900)' }}>⚠ {w}</div>
          ))}
        </section>
      )}

      {/* Detected binaries — read-only system status */}
      <section className="pc-card" style={{ padding: 16, marginTop: 16 }}>
        <h2>Detected on PATH</h2>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          <li>
            <code>claude</code>: {binaries.claude
              ? <span style={{ color: 'var(--good)' }}>✓ {binaries.claude}</span>
              : <span style={{ color: 'var(--bad)' }}>✗ not found</span>}
          </li>
          <li>
            <code>omp</code>: {binaries.omp
              ? <span style={{ color: 'var(--good)' }}>✓ {binaries.omp}</span>
              : <span style={{ color: 'var(--fg-mute)' }}>not found ({' '}
                  <code>bun add -g @oh-my-pi/pi-coding-agent</code>
                {' '})</span>}
          </li>
          {binaries.pi && binaries.pi !== binaries.omp && (
            <li>
              <code>pi</code>: <span style={{ color: 'var(--good)' }}>✓ {binaries.pi}</span>
              {' '}<span style={{ color: 'var(--fg-mute)' }}>(alias of omp)</span>
            </li>
          )}
        </ul>
        <p style={{ fontSize: 12, color: 'var(--fg-mute)', marginTop: 8, marginBottom: 0 }}>
          Effective backend right now: <code>{effectiveBackend}</code>
          {(envOverrides.AGENT_BACKEND || envOverrides.AGENT_CMD || envOverrides.CLAUDE_CMD) && (
            <>
              {' '}· env overrides active:
              {envOverrides.AGENT_BACKEND && <> <code>AGENT_BACKEND={envOverrides.AGENT_BACKEND}</code></>}
              {envOverrides.AGENT_CMD && <> <code>AGENT_CMD={envOverrides.AGENT_CMD}</code></>}
              {envOverrides.CLAUDE_CMD && <> <code>CLAUDE_CMD={envOverrides.CLAUDE_CMD}</code></>}
            </>
          )}
        </p>
      </section>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <FormField
          label="Backend (sets AGENT_BACKEND)"
          description="The CLI the orchestrator + harness drive. 'omp' is the default (routes through Meridian + Claude Max). 'claude-code' uses the local `claude` CLI. 'codex' uses the local `codex` CLI (ChatGPT OAuth). 'auto' infers from the binary name and falls back to omp."
        >
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {(['auto', 'claude-code', 'omp', 'codex'] as const).map((b) => (
              <label key={b} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="radio"
                  name="backend"
                  value={b}
                  checked={backend === b}
                  onChange={() => setBackend(b)}
                />
                <code>{b}</code>
                {b === 'omp' && !binaries.omp && (
                  <span style={{ color: 'var(--bad)', fontSize: 11 }}>(binary not found)</span>
                )}
                {b === 'claude-code' && !binaries.claude && (
                  <span style={{ color: 'var(--bad)', fontSize: 11 }}>(binary not found)</span>
                )}
              </label>
            ))}
          </div>
        </FormField>

        <FormField
          label="Custom command (sets AGENT_CMD)"
          description={`Overrides the default binary + flags. Equivalent to setting the AGENT_CMD env var. Leave empty for "${defaultCmd}" (or the host environment's own value).`}
        >
          <input
            type="text"
            placeholder={backend === 'omp' || backend === 'auto' ? 'omp -p' : backend === 'codex' ? 'codex exec' : 'claude -p --dangerously-skip-permissions'}
            className="pc-input"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
          />
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(['omp -p', 'claude -p', 'claude -p --dangerously-skip-permissions', ''] as const).map((preset) => (
              <button
                key={preset || 'clear'}
                type="button"
                className="pc-btn pc-btn-secondary"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => setCmd(preset)}
              >
                {preset === '' ? 'clear' : preset === 'claude -p --dangerously-skip-permissions' ? 'claude -p (skip perms)' : preset}
              </button>
            ))}
          </div>
        </FormField>

        <FormField
          label="Per-role model overrides (JSON)"
          description={`Shape: { "<role>": "<model-id>" }. Roles: ${ROLE_HINTS.join(', ')}. Use the explicit provider/model form (e.g. "anthropic/claude-opus-4-7"). "operator" sets the chat brain — its default is pinned to Anthropic because the large converse prompt is unreliable on some providers; override at your own risk. Per-harness .papercusp/config.json values still win.`}
        >
          <textarea
            rows={6}
            placeholder='{\n  "worker": "haiku",\n  "reviewer": "opus"\n}'
            className="pc-input"
            style={{ fontFamily: 'monospace', fontSize: 12 }}
            value={modelsJson}
            onChange={(e) => setModelsJson(e.target.value)}
          />
        </FormField>

        <FormField
          label="Model tiers (weakest → strongest)"
          description="The effort-level menu per-task model picks resolve against: the queen passes a tier name on fleet:spawn and the spawn runs at that tier's model, clamped between the role's default (floor — a tier can escalate a role, never downgrade it) and the role's ceiling below. Row order is the strength ranking. Claude aliases: haiku · sonnet · opus · fable, with optional :low|:medium|:high|:xhigh|:max. 'When to use' is YOUR instruction to the queen — the live menu (names, specs, and these lines) is injected into her prompt at launch, so write the situation each tier is for. Leave as-is to track the built-in menu."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--fg-mute)' }}>
              <span style={{ width: 14 }} />
              <span style={{ width: 110 }}>Tier</span>
              <span style={{ width: 170 }}>Model spec</span>
              <span style={{ width: 130 }}>Backend</span>
              <span>When to use (the queen&apos;s rubric)</span>
            </div>
            {tierRows.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--fg-mute)', width: 14, textAlign: 'right' }}>{i + 1}</span>
                <input
                  className="pc-input"
                  style={{ fontSize: 13, padding: '2px 6px', width: 110 }}
                  placeholder="tier name"
                  aria-label={`Tier ${i + 1} name`}
                  value={row.name}
                  onChange={(e) => {
                    setTiersCustomized(true);
                    setTierRows((prev) => prev.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)));
                  }}
                />
                <input
                  className="pc-input"
                  style={{
                    fontSize: 13,
                    padding: '2px 6px',
                    width: 170,
                    fontFamily: 'monospace',
                    ...(row.spec.trim() && (!isValidModelSpec(row.spec.trim()) || aliasWarning(row.spec))
                      ? { borderColor: 'var(--warn, #b58900)' }
                      : {}),
                  }}
                  placeholder="model[:effort], e.g. opus:high"
                  aria-label={`Tier ${i + 1} model spec`}
                  value={row.spec}
                  onChange={(e) => {
                    setTiersCustomized(true);
                    setTierRows((prev) => prev.map((r, j) => (j === i ? { ...r, spec: e.target.value } : r)));
                  }}
                />
                <Select
                  value={row.backend || 'inherit'}
                  ariaLabel={`Tier ${i + 1} backend`}
                  options={BACKEND_CHOICE_OPTIONS}
                  triggerStyle={{ fontSize: 13 }}
                  onChange={(v) => {
                    setTiersCustomized(true);
                    setTierRows((prev) => prev.map((r, j) =>
                      j === i ? { ...r, backend: v === 'inherit' ? '' : (v as AgentBackend) } : r,
                    ));
                  }}
                />
                <input
                  className="pc-input"
                  style={{ fontSize: 13, padding: '2px 6px', flex: 1, minWidth: 180 }}
                  placeholder="when the queen should pick this tier"
                  aria-label={`Tier ${i + 1} when-to-use guidance`}
                  value={row.when}
                  onChange={(e) => {
                    setTiersCustomized(true);
                    setTierRows((prev) => prev.map((r, j) => (j === i ? { ...r, when: e.target.value } : r)));
                  }}
                />
                <button
                  type="button"
                  className="pc-btn pc-btn-secondary"
                  style={{ fontSize: 11, padding: '2px 8px' }}
                  onClick={() => {
                    setTiersCustomized(true);
                    setTierRows((prev) => prev.filter((_, j) => j !== i));
                  }}
                >
                  remove
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                className="pc-btn pc-btn-secondary"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => {
                  setTiersCustomized(true);
                  setTierRows((prev) => [...prev, { name: '', spec: '', backend: '', when: '' }]);
                }}
              >
                + add tier
              </button>
              <button
                type="button"
                className="pc-btn pc-btn-secondary"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => {
                  setTiersCustomized(false);
                  setTierRows(DEFAULT_MODEL_TIERS.map(tierToRow));
                }}
              >
                reset to defaults
              </button>
              {!tiersCustomized && (
                <span style={{ fontSize: 11, color: 'var(--fg-mute)', alignSelf: 'center' }}>
                  built-in menu (not stored — tracks future defaults)
                </span>
              )}
            </div>
          </div>
        </FormField>

        <FormField
          label="Per-role tier ceilings"
          description="The strongest tier a per-task pick may run that role at — the budget envelope. Empty = the strongest tier is allowed. The floor is not configured: it derives from the role's default model above."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {CEILING_ROLES.map((role) => (
              <div key={role} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <code style={{ minWidth: 110 }}>{role}</code>
                <Select
                  value={tierCeilings[role] ?? 'none'}
                  ariaLabel={`Tier ceiling for ${role}`}
                  triggerStyle={{ fontSize: 13 }}
                  options={[
                    { value: 'none', label: 'No ceiling' },
                    ...tierRows.filter((t) => t.name.trim()).map((t) => ({ value: t.name, label: t.name })),
                  ]}
                  onChange={(v) =>
                    setTierCeilings((prev) => {
                      const next = { ...prev };
                      if (v && v !== 'none') next[role] = v;
                      else delete next[role];
                      return next;
                    })
                  }
                />
              </div>
            ))}
          </div>
        </FormField>

        <FormField
          label="Per-surface backend + model"
          description="Override which CLI runs each in-app brain, and optionally pin a model for that surface. 'Inherit global' uses the backend above; an empty model uses the backend default."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {SURFACE_KEYS.map((surface) => (
              <div
                key={surface}
                style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
              >
                <code style={{ minWidth: 110 }}>{surface}</code>
                <Select
                  value={surfaceBackends[surface]}
                  ariaLabel={`Backend for ${surface}`}
                  triggerStyle={{ fontSize: 13 }}
                  options={BACKEND_CHOICE_OPTIONS}
                  onChange={(v) =>
                    setSurfaceBackends((prev) => ({
                      ...prev,
                      [surface]: v as SurfaceChoice,
                    }))
                  }
                />
                <input
                  className="pc-input"
                  style={{ fontSize: 13, padding: '2px 6px', width: 160 }}
                  placeholder="model (optional)"
                  aria-label={`Model for ${surface}`}
                  value={surfaceModels[surface]}
                  onChange={(e) =>
                    setSurfaceModels((prev) => ({
                      ...prev,
                      [surface]: e.target.value,
                    }))
                  }
                />
              </div>
            ))}
          </div>
        </FormField>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="pc-btn"
            onClick={runTest}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test current backend'}
          </button>
        </div>
      </div>

      {/* Test result panel */}
      {testResult && (
        <section
          className="pc-card"
          style={{
            padding: 16,
            marginTop: 16,
            borderColor: testResult.ok ? 'var(--good)' : 'var(--bad)',
          }}
        >
          <h2>
            {testResult.ok ? '✓ Backend test passed' : '✗ Backend test failed'}
          </h2>
          {testResult.ok ? (
            <p style={{ fontSize: 13, margin: 0 }}>
              Reply: <code>{testResult.finalText.slice(0, 200)}</code>
              {' '}· {testResult.durationMs}ms
              {testResult.costUsd > 0 && <> · ${testResult.costUsd.toFixed(4)}</>}
            </p>
          ) : (
            <pre style={{ fontSize: 12, color: 'var(--bad)', whiteSpace: 'pre-wrap', margin: 0 }}>
              {testResult.error ?? '(no error message)'}
            </pre>
          )}
        </section>
      )}

      {/* Headless caveat */}
      <section className="pc-card" style={{ padding: 16, marginTop: 16 }}>
        <h2>Headless harness runs</h2>
        <p style={{ fontSize: 13, margin: 0 }}>
          When you run the harness orchestrator from a terminal directly
          (outside the operator), it does NOT inherit settings from this
          page — it reads <code>$AGENT_BACKEND</code>/<code>$AGENT_CMD</code>{' '}
          from the shell instead. Either set them before invoking:
        </p>
        <pre className="pc-code" style={{ marginTop: 8 }}>{`export AGENT_BACKEND=${backend === 'auto' ? 'omp' : backend}
export AGENT_CMD='${defaultCmd}'`}</pre>
        <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: 0 }}>
          …or rely on the binary auto-inference (the orchestrator detects{' '}
          <code>omp</code>/<code>pi</code> in the command name).
        </p>
      </section>
    </div>
  );
}
