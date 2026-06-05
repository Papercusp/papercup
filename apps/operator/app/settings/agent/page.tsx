'use client';

/**
 * Agent backend settings — pick which CLI (claude-code or omp) the
 * operator + harness drive, override the binary if needed, and set
 * per-role model defaults.
 *
 * Persisted to <papercuspRoot>/agent/config.json. Changes take effect
 * for in-process spawns immediately (the API route mirrors into
 * process.env). Headless orchestrator invocations from a terminal don't
 * inherit; users have to set $AGENT_BACKEND themselves there.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { useFormWith, FormField, SubmitButton } from '@/lib/forms';
import { SURFACE_KEYS, type SurfaceKey, type AgentBackend } from '@papercusp/operator-core/lib/agent-config-constants';

/** Local select value: a concrete backend, or 'inherit' = omit from the map. */
type SurfaceChoice = 'inherit' | AgentBackend;

const ConfigSchema = z.object({
  backend: z.enum(['auto', 'claude-code', 'omp', 'codex']),
  cmd: z.string().optional().default(''),
  // Per-role models stored as a JSON-string textarea so users can
  // copy/paste between machines. Validated on submit.
  modelsJson: z.string().optional().default(''),
});
type ConfigFormData = z.infer<typeof ConfigSchema>;

interface AgentConfig {
  backend: 'auto' | 'claude-code' | 'omp' | 'codex';
  cmd: string;
  models: Record<string, string>;
  backends?: Partial<Record<SurfaceKey, AgentBackend>>;
  surfaceModels?: Partial<Record<SurfaceKey, string>>;
}
interface DetectedBinaries {
  claude: string | null;
  omp: string | null;
  pi: string | null;
}
interface ConfigSnapshot {
  config: AgentConfig;
  binaries: DetectedBinaries;
  effectiveBackend: 'claude-code' | 'omp' | 'codex';
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

export default function AgentSettingsPage() {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [loading, setLoading] = useState(true);
  // Per-surface backend overrides. 'inherit' means "omit from the map" (use
  // the global backend above). Mid-edit draft, so plain useState rather than
  // nuqs — it's wiped on reload from the fetched config like the other fields.
  const [surfaceBackends, setSurfaceBackends] = useState<Record<SurfaceKey, SurfaceChoice>>(
    () => Object.fromEntries(SURFACE_KEYS.map((k) => [k, 'inherit'])) as Record<SurfaceKey, SurfaceChoice>,
  );
  // Per-surface model overrides (OQ3 companion to surfaceBackends). '' = inherit
  // the surface's own default model. Needed when a surface's backend differs
  // from the global one and the default model id won't resolve there.
  const [surfaceModels, setSurfaceModels] = useState<Record<SurfaceKey, string>>(
    () => Object.fromEntries(SURFACE_KEYS.map((k) => [k, ''])) as Record<SurfaceKey, string>,
  );

  const { register, submit, reset, isSubmitting, watch } = useFormWith(ConfigSchema, {
    defaultValues: { backend: 'omp', cmd: '', modelsJson: '' },
  });
  const watchBackend = watch('backend');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/agent-config');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as ConfigSnapshot;
      setSnapshot(d);
      reset({
        backend: d.config.backend,
        cmd: d.config.cmd,
        modelsJson: Object.keys(d.config.models).length > 0
          ? JSON.stringify(d.config.models, null, 2)
          : '',
      });
      const fetched = d.config.backends ?? {};
      setSurfaceBackends(
        Object.fromEntries(
          SURFACE_KEYS.map((k) => [k, fetched[k] ?? 'inherit']),
        ) as Record<SurfaceKey, SurfaceChoice>,
      );
      const fetchedModels = d.config.surfaceModels ?? {};
      setSurfaceModels(
        Object.fromEntries(
          SURFACE_KEYS.map((k) => [k, fetchedModels[k] ?? '']),
        ) as Record<SurfaceKey, string>,
      );
    } catch (err) {
      toast.error(`load failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [reset]);

  useEffect(() => { void load(); }, [load]);

  const onSubmit = async (data: ConfigFormData) => {
    let models: Record<string, string> = {};
    if (data.modelsJson && data.modelsJson.trim()) {
      try {
        const parsed = JSON.parse(data.modelsJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('models must be a JSON object of { role: model }');
        }
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof k !== 'string' || typeof v !== 'string') {
            throw new Error(`invalid models entry: ${k} = ${typeof v}`);
          }
          models[k] = v;
        }
      } catch (err) {
        toast.error(`models JSON: ${(err as Error).message}`);
        return;
      }
    }
    // Only surfaces set to a concrete backend go in the map; 'inherit' ones
    // are omitted so they fall back to the global backend.
    const backends: Partial<Record<SurfaceKey, AgentBackend>> = {};
    const surfaceModelsOut: Partial<Record<SurfaceKey, string>> = {};
    for (const k of SURFACE_KEYS) {
      const choice = surfaceBackends[k];
      if (choice !== 'inherit') backends[k] = choice;
      const m = surfaceModels[k]?.trim();
      if (m) surfaceModelsOut[k] = m;
    }
    try {
      const r = await fetch('/api/agent-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backend: data.backend, cmd: data.cmd ?? '', models, backends, surfaceModels: surfaceModelsOut }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      toast.success('Saved. In-process spawns now use the new backend.');
      await load();
    } catch (err) {
      toast.error(`save failed: ${(err as Error).message}`);
    }
  };

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

  if (loading) return <div><h1>Agent backend</h1><p className="pc-settings-loading">Loading…</p></div>;
  if (!snapshot) return <div><h1>Agent backend</h1><p style={{ color: 'var(--bad)' }}>Failed to load config.</p></div>;

  const { binaries, effectiveBackend, envOverrides } = snapshot;

  return (
    <div>
      <h1>Agent backend</h1>
      <p className="pc-settings-intro">
        Which agent CLI the operator and harness drive. Two backends are
        supported: <code>claude-code</code> (Anthropic <code>claude</code>)
        and <code>omp</code> (<a
          href="https://github.com/can1357/oh-my-pi"
          target="_blank"
          rel="noreferrer"
          style={{ color: 'var(--accent)' }}
        >oh-my-pi</a>) — the multi-provider option.
      </p>

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

      {/* Form */}
      <form onSubmit={submit(onSubmit)} style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <FormField
          label="Backend (sets AGENT_BACKEND)"
          description="The CLI the orchestrator + harness drive. 'omp' is the default (routes through Meridian + Claude Max). 'claude-code' uses the local `claude` CLI. 'codex' uses the local `codex` CLI (ChatGPT OAuth). 'auto' infers from the binary name and falls back to omp."
        >
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {(['auto', 'claude-code', 'omp', 'codex'] as const).map((b) => (
              <label key={b} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                <input type="radio" value={b} {...register('backend')} />
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
          description={`Overrides the default binary + flags. Equivalent to setting the AGENT_CMD env var. Leave empty for "${watchBackend === 'omp' ? 'omp -p' : watchBackend === 'codex' ? 'codex exec' : 'claude -p'}".`}
        >
          <input
            type="text"
            placeholder={watchBackend === 'omp' ? 'omp -p' : watchBackend === 'codex' ? 'codex exec' : 'claude -p --dangerously-skip-permissions'}
            className="pc-input"
            {...register('cmd')}
          />
          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() => reset({ ...watch(), cmd: 'omp -p' })}
            >
              omp -p
            </button>
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() => reset({ ...watch(), cmd: 'claude -p' })}
            >
              claude -p
            </button>
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() => reset({ ...watch(), cmd: 'claude -p --dangerously-skip-permissions' })}
            >
              claude -p (skip perms)
            </button>
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              style={{ fontSize: 11, padding: '2px 8px' }}
              onClick={() => reset({ ...watch(), cmd: '' })}
            >
              clear
            </button>
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
            {...register('modelsJson')}
          />
        </FormField>

        <FormField
          label="Per-surface backend + model"
          description="Override which CLI runs each in-app brain, and optionally pin a model for that surface. 'Inherit global' uses the backend above; an empty model uses the backend default."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {SURFACE_KEYS.map((surface) => (
              <label
                key={surface}
                style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
              >
                <code style={{ minWidth: 110 }}>{surface}</code>
                <select
                  className="pc-input"
                  style={{ fontSize: 13, padding: '2px 6px', width: 'auto' }}
                  value={surfaceBackends[surface]}
                  onChange={(e) =>
                    setSurfaceBackends((prev) => ({
                      ...prev,
                      [surface]: e.target.value as SurfaceChoice,
                    }))
                  }
                >
                  <option value="inherit">Inherit global</option>
                  <option value="omp">omp</option>
                  <option value="claude-code">claude-code</option>
                  <option value="codex">codex</option>
                </select>
                <input
                  className="pc-input"
                  style={{ fontSize: 13, padding: '2px 6px', width: 160 }}
                  placeholder="model (optional)"
                  value={surfaceModels[surface]}
                  onChange={(e) =>
                    setSurfaceModels((prev) => ({
                      ...prev,
                      [surface]: e.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
        </FormField>

        <div style={{ display: 'flex', gap: 8 }}>
          <SubmitButton pending={isSubmitting}>Save</SubmitButton>
          <button
            type="button"
            className="pc-btn"
            onClick={runTest}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test current backend'}
          </button>
        </div>
      </form>

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
        <pre className="pc-code" style={{ marginTop: 8 }}>{`export AGENT_BACKEND=${watchBackend === 'auto' ? 'omp' : watchBackend}
export AGENT_CMD='${watchBackend === 'omp' ? 'omp -p' : watchBackend === 'codex' ? 'codex exec' : 'claude -p'}'`}</pre>
        <p style={{ fontSize: 12, color: 'var(--fg-mute)', margin: 0 }}>
          …or rely on the binary auto-inference (the orchestrator detects{' '}
          <code>omp</code>/<code>pi</code> in the command name).
        </p>
      </section>
    </div>
  );
}
