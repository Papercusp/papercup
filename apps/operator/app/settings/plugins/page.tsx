/**
 * Settings → Plugins
 *
 * Per-harness plugin configuration UI. Lists every installed plugin that
 * declares a `configSchema`, lets the operator pick a harness, and renders
 * a generic JSON-schema-driven form (string / boolean / number / required
 * markers) backed by `GET|PUT /api/plugins/config?harness=<slug>&plugin=<dir>`.
 *
 * Settings are per-harness because the underlying contract is per-harness:
 * each harness owns its own plugin-configs directory under
 * `~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json`. A future
 * "global plugin defaults" surface would layer above this.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

interface InstalledPlugin {
  name: string;
  version?: string;
  description?: string;
  path?: string;
  configSchema?: { type?: string; required?: string[]; properties?: Record<string, ConfigField> };
}

interface ConfigField {
  type?: 'string' | 'boolean' | 'number' | 'integer' | 'array';
  default?: unknown;
  description?: string;
  enum?: unknown[];
  format?: string;
}

interface HarnessRow {
  slug: string;
  version?: string | null;
  description?: string | null;
}

function pluginDirSlug(name: string): string {
  // Mirror plugin-loader's safe-name rule: take the last segment of an
  // npm-scoped name (`@papercupai/foo` → `foo`).
  const last = name.split('/').pop() ?? name;
  return last.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export default function PluginSettingsPage() {
  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [harnesses, setHarnesses] = useState<HarnessRow[]>([]);
  const [enabledByHarness, setEnabledByHarness] = useState<Record<string, string[]>>({});
  const [activeHarness, setActiveHarness] = useState<string>('');
  const [activePlugin, setActivePlugin] = useState<string>('');
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Initial load: plugins + harnesses + enabled state.
  useEffect(() => {
    (async () => {
      try {
        const [a, b, c] = await Promise.all([
          fetch('/api/plugins/global', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/installed', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/plugins/enabled', { cache: 'no-store' }).then((r) => r.json()),
        ]);
        setPlugins(Array.isArray(a?.plugins) ? a.plugins : []);
        setHarnesses(Array.isArray(b?.harnesses) ? b.harnesses : []);
        setEnabledByHarness(c?.enabled ?? {});
      } catch (e: any) {
        toast.error(`load failed: ${e?.message ?? e}`);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Plugins worth showing: those that declare a configSchema.
  const configurable = useMemo(
    () => (plugins ?? []).filter((p) => p.configSchema && Object.keys(p.configSchema.properties ?? {}).length > 0),
    [plugins],
  );

  // Default harness selection: first harness that has any plugin enabled.
  useEffect(() => {
    if (!activeHarness && harnesses.length > 0) {
      const firstWithPlugins = harnesses.find((h) => (enabledByHarness[h.slug]?.length ?? 0) > 0);
      setActiveHarness(firstWithPlugins?.slug ?? harnesses[0].slug);
    }
  }, [harnesses, enabledByHarness, activeHarness]);

  // When harness or plugin changes, fetch its current config.
  useEffect(() => {
    if (!activeHarness || !activePlugin) return;
    setConfig(null);
    setDraft({});
    const dirSlug = pluginDirSlug(activePlugin);
    fetch(`/api/plugins/config?harness=${encodeURIComponent(activeHarness)}&plugin=${encodeURIComponent(dirSlug)}`)
      .then((r) => r.json())
      .then((d) => {
        setConfig(d?.config ?? {});
        setDraft({}); // empty form means "no change"; defaults still display
      })
      .catch((e) => toast.error(`config load failed: ${e?.message ?? e}`));
  }, [activeHarness, activePlugin]);

  const activePluginManifest = configurable.find((p) => p.name === activePlugin);
  const enabledHere = !!activeHarness && (enabledByHarness[activeHarness] ?? []).some(
    (s) => s === activePlugin || s === pluginDirSlug(activePlugin),
  );

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!activeHarness || !activePlugin) return;
    if (Object.keys(draft).length === 0) {
      toast.message('No changes to save.');
      return;
    }
    setSaving(true);
    try {
      // Merge: load → overlay draft → write back. Empty strings drop the key.
      const merged = { ...(config ?? {}) };
      for (const [k, v] of Object.entries(draft)) {
        if (typeof v === 'string' && v.length === 0) delete merged[k];
        else merged[k] = v;
      }
      const r = await fetch('/api/plugins/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          harness: activeHarness,
          plugin: pluginDirSlug(activePlugin),
          config: merged,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      toast.success(`Saved ${activePlugin} config`, { description: `hash ${(d.configHash ?? '').slice(0, 16)}…` });
      setConfig(merged);
      setDraft({});
    } catch (e: any) {
      toast.error(`save failed: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 24 }}>Loading…</div>;

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2 style={{ margin: '0 0 4px' }}>Plugin settings</h2>
      <p style={{ color: 'var(--fg-mute, #999)', marginTop: 0 }}>
        Per-harness configuration for installed plugins. Reads/writes
        <code style={{ margin: '0 4px' }}>~/.papercusp/harnesses/&lt;slug&gt;/plugin-configs/</code>.
      </p>

      {harnesses.length === 0 ? (
        <p>No harnesses installed yet.</p>
      ) : configurable.length === 0 ? (
        <p>No installed plugin declares a <code>configSchema</code>.</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 24 }}>
          <aside>
            <label style={lbl}>Harness</label>
            <select
              value={activeHarness}
              onChange={(e) => { setActiveHarness(e.target.value); setActivePlugin(''); }}
              style={input}
            >
              {harnesses.map((h) => (
                <option key={h.slug} value={h.slug}>{h.slug}</option>
              ))}
            </select>

            <label style={{ ...lbl, marginTop: 16 }}>Plugin</label>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {configurable.map((p) => {
                const isActive = p.name === activePlugin;
                const enabled = (enabledByHarness[activeHarness] ?? []).some(
                  (s) => s === p.name || s === pluginDirSlug(p.name),
                );
                return (
                  <li key={p.name}>
                    <button
                      type="button"
                      onClick={() => setActivePlugin(p.name)}
                      style={{
                        ...pluginBtn,
                        background: isActive ? 'var(--bg-1, #1e1e1e)' : 'transparent',
                        opacity: enabled ? 1 : 0.55,
                      }}
                      title={enabled ? '' : 'Not enabled in this harness'}
                    >
                      {p.name.split('/').pop()}
                      {!enabled && <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--fg-mute, #888)' }}>off</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <main>
            {!activePlugin ? (
              <p style={{ color: 'var(--fg-mute, #999)' }}>Select a plugin on the left to configure it.</p>
            ) : !activePluginManifest ? (
              <p>Plugin not found.</p>
            ) : (
              <form onSubmit={onSave}>
                <div style={{ marginBottom: 16 }}>
                  <h3 style={{ margin: '0 0 4px' }}>{activePluginManifest.name}</h3>
                  <div style={{ fontSize: 12, color: 'var(--fg-mute, #999)' }}>v{activePluginManifest.version}</div>
                  {activePluginManifest.description && (
                    <p style={{ margin: '8px 0 0', fontSize: 13 }}>{activePluginManifest.description}</p>
                  )}
                  {!enabledHere && (
                    <div style={notice}>
                      Not currently enabled on <strong>{activeHarness}</strong>. Saved config will apply
                      once you enable it from the harness dashboard's plugin picker.
                    </div>
                  )}
                </div>
                {Object.entries(activePluginManifest.configSchema!.properties ?? {}).map(([key, field]) => {
                  const required = activePluginManifest.configSchema!.required?.includes(key);
                  const current = (key in draft) ? draft[key] : config?.[key] ?? field.default ?? '';
                  return (
                    <div key={key} style={{ marginBottom: 16 }}>
                      <label style={lbl}>
                        {key} {required && <span style={{ color: '#ff6961' }}>*</span>}
                      </label>
                      {field.description && (
                        <div style={{ fontSize: 12, color: 'var(--fg-mute, #999)', marginBottom: 4 }}>{field.description}</div>
                      )}
                      {renderInput(key, field, current, (v) => setDraft({ ...draft, [key]: v }))}
                    </div>
                  );
                })}
                <button type="submit" disabled={saving} style={primary}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </form>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function renderInput(
  key: string,
  field: ConfigField,
  value: unknown,
  onChange: (v: unknown) => void,
): React.ReactElement {
  if (field.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.type === 'number' || field.type === 'integer') {
    return (
      <input
        type="number"
        value={typeof value === 'number' || typeof value === 'string' ? String(value) : ''}
        onChange={(e) => {
          const n = e.target.value === '' ? '' : Number(e.target.value);
          onChange(n);
        }}
        style={input}
      />
    );
  }
  if (field.enum && Array.isArray(field.enum)) {
    return (
      <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={input}>
        {field.enum.map((opt) => (
          <option key={String(opt)} value={String(opt)}>{String(opt)}</option>
        ))}
      </select>
    );
  }
  // Strings — secret-ish keys get type=password.
  const isSecret = /token|key|secret|password/i.test(key);
  return (
    <input
      type={isSecret ? 'password' : 'text'}
      value={typeof value === 'string' ? value : (value == null ? '' : String(value))}
      onChange={(e) => onChange(e.target.value)}
      style={input}
      autoComplete="off"
    />
  );
}

const lbl: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--fg-mute, #ccc)', marginBottom: 4,
  textTransform: 'uppercase', letterSpacing: '.04em',
};
const input: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--bg-1, #141414)',
  border: '1px solid var(--border, #2a2a2a)', borderRadius: 4, color: 'var(--fg, #ddd)',
  fontSize: 13, fontFamily: 'inherit',
};
const pluginBtn: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '6px 10px',
  border: '1px solid var(--border, #2a2a2a)', borderRadius: 4, color: 'var(--fg, #ddd)',
  background: 'transparent', cursor: 'pointer', fontSize: 13, marginBottom: 4,
};
const primary: React.CSSProperties = {
  padding: '8px 16px', background: 'var(--accent, #58a6ff)', color: '#000',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
};
const notice: React.CSSProperties = {
  marginTop: 12, padding: '8px 12px', background: 'rgba(255, 200, 50, 0.08)',
  border: '1px solid rgba(255, 200, 50, 0.3)', borderRadius: 4, fontSize: 12, color: '#cc9',
};
