/**
 * Fork-completion form.
 *
 * Reads the snapshot's per-plugin shape via /api/snapshots/[id]/shape,
 * renders inputs for fields that were stripped (`shareable: false` /
 * `secret: true` / `oauth`), and POSTs to /api/snapshots/[id]/instantiate
 * with the completed `pluginConfigOverrides`.
 *
 * Spec: /docs/snapshots/share-semantics + oauth-integration.
 */
'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

interface ShapeField {
  reason: 'secret-strip' | 'secret-include' | 'secret-warn' | 'shareable-false' | 'pattern-fallback';
  oauth?: { provider: string; scopes?: string[] };
  pattern?: string;
  description?: string;
  flaggedShareableButLooksSecret?: boolean;
}

interface PluginShape {
  name: string;
  version: string;
  pluginVersionPinned: boolean;
  shape: { fields: Record<string, ShapeField>; warnings?: string[] } | null;
  preservedConfig: Record<string, unknown> | null;
}

interface SecurityAdvisory {
  cve?: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  fixedIn?: string;
  summary: string;
  advisoryUrl?: string;
}

interface AdvisoryCheck {
  state: 'clean' | 'flagged' | 'unknown';
  advisories?: SecurityAdvisory[];
  latestSafeVersion?: string;
  reason?: string;
}

interface Props {
  snapshotId: string;
  /** Called after a successful fork. */
  onSuccess?: (slug: string) => void;
}

export function ForkCompletionForm({ snapshotId, onSuccess }: Props) {
  const [plugins, setPlugins] = useState<PluginShape[] | null>(null);
  const [advisories, setAdvisories] = useState<Record<string, AdvisoryCheck>>({});
  const [name, setName] = useState('');
  const [overrides, setOverrides] = useState<Record<string, Record<string, string>>>({});
  const [forking, setForking] = useState(false);
  const [acknowledgeAdvisories, setAcknowledgeAdvisories] = useState(false);

  useEffect(() => {
    fetch(`/api/snapshots/${encodeURIComponent(snapshotId)}/shape`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) {
          toast.error(`shape fetch failed: ${d.error ?? 'unknown'}`);
          return;
        }
        setPlugins(d.plugins);
        // Fire advisory checks in parallel for every pinned plugin.
        const list = d.plugins as PluginShape[];
        const pinned = list.filter((p) => p.pluginVersionPinned !== false);
        Promise.all(
          pinned.map(async (p) => {
            try {
              const r = await fetch('/api/security-advisories/check', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ plugin: p.name, version: p.version }),
              });
              const j = await r.json();
              return [p.name, j.result as AdvisoryCheck] as const;
            } catch {
              return [p.name, { state: 'unknown' as const, reason: 'network' }] as const;
            }
          }),
        ).then((entries) => {
          setAdvisories(Object.fromEntries(entries));
        });
      })
      .catch((e) => toast.error(`shape error: ${e?.message ?? e}`));
  }, [snapshotId]);

  function setField(plugin: string, field: string, value: string) {
    setOverrides((prev) => ({
      ...prev,
      [plugin]: { ...(prev[plugin] ?? {}), [field]: value },
    }));
  }

  async function fork() {
    setForking(true);
    try {
      const r = await fetch(`/api/snapshots/${encodeURIComponent(snapshotId)}/instantiate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim() || undefined,
          pluginConfigOverrides: overrides,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`fork failed: ${d.error ?? `HTTP ${r.status}`}`);
        return;
      }
      toast.success(`Forked → ${d.newSlug}`);
      onSuccess?.(d.newSlug);
    } catch (e: any) {
      toast.error(`fork crashed: ${e?.message ?? e}`);
    } finally {
      setForking(false);
    }
  }

  if (plugins === null) return <div style={{ padding: 16 }}>Loading snapshot shape…</div>;

  const pluginsWithFields = plugins.filter((p) => p.shape && Object.keys(p.shape.fields ?? {}).length > 0);
  const flaggedAdvisories = Object.entries(advisories).filter(([, v]) => v.state === 'flagged');
  const blockingAdvisories = flaggedAdvisories.length > 0 && !acknowledgeAdvisories;

  return (
    <div style={{ padding: 16, maxWidth: 640 }}>
      <h3 style={{ marginTop: 0 }}>Fork this snapshot</h3>

      {flaggedAdvisories.length > 0 && (
        <div style={advisoryBanner}>
          <strong>⚠ Security advisories on pinned versions</strong>
          <ul style={{ margin: '6px 0 0 0', paddingLeft: 18, fontSize: 13 }}>
            {flaggedAdvisories.map(([plugin, ck]) => (
              <li key={plugin} style={{ marginBottom: 4 }}>
                <strong>{plugin}</strong>: {ck.advisories?.map((a) =>
                  `[${a.severity}] ${a.cve ?? ''} ${a.summary}`).join('; ')}
                {ck.latestSafeVersion && (
                  <em style={{ marginLeft: 6, color: 'var(--fg-mute, #aaa)' }}>
                    fixed in {ck.latestSafeVersion}
                  </em>
                )}
              </li>
            ))}
          </ul>
          <label style={{ marginTop: 8, display: 'inline-block', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={acknowledgeAdvisories}
              onChange={(e) => setAcknowledgeAdvisories(e.target.checked)}
            />
            <span style={{ marginLeft: 6 }}>
              I understand and want to fork with the pinned vulnerable version anyway.
            </span>
          </label>
        </div>
      )}

      <div style={{ marginBottom: 16 }}>
        <label style={lbl}>New harness name (optional)</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="auto-generated if blank"
          style={input}
        />
      </div>

      {pluginsWithFields.length === 0 ? (
        <p style={{ color: 'var(--fg-mute, #aaa)' }}>
          This snapshot has no stripped fields — fork directly.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 13, color: 'var(--fg-mute, #ccc)' }}>
            Some plugin config was stripped from the snapshot. Fill in your own values
            (or click <em>Connect with X</em> for OAuth-backed credentials).
          </p>
          {pluginsWithFields.map((p) => (
            <PluginFields
              key={p.name}
              plugin={p}
              overrides={overrides[pluginSlug(p.name)] ?? {}}
              onSetField={(f, v) => setField(pluginSlug(p.name), f, v)}
            />
          ))}
        </>
      )}

      <button onClick={fork} disabled={forking || blockingAdvisories} style={primary}>
        {forking ? 'Forking…' : blockingAdvisories ? 'Acknowledge advisories to fork' : 'Fork'}
      </button>
    </div>
  );
}

function pluginSlug(name: string): string {
  const last = name.split('/').pop() ?? name;
  return last.replace(/[^a-zA-Z0-9._-]/g, '_');
}

interface PluginFieldsProps {
  plugin: PluginShape;
  overrides: Record<string, string>;
  onSetField: (field: string, value: string) => void;
}

function PluginFields({ plugin, overrides, onSetField }: PluginFieldsProps) {
  const fields = Object.entries(plugin.shape!.fields);
  return (
    <div style={pluginCard}>
      <header style={{ marginBottom: 8 }}>
        <strong>{plugin.name}</strong>{' '}
        <span style={{ fontSize: 12, color: 'var(--fg-mute, #888)' }}>v{plugin.version}{plugin.pluginVersionPinned && ' · pinned'}</span>
      </header>
      {fields.map(([fieldName, shape]) => {
        const value = overrides[fieldName] ?? '';
        const reasonLabel =
          shape.reason === 'shareable-false' ? 'publisher-specific' :
          shape.reason === 'secret-strip' ? 'secret' :
          shape.reason === 'secret-warn' ? 'secret (warned)' :
          shape.reason === 'pattern-fallback' ? 'matched secret pattern' :
          'included';

        if (shape.reason === 'secret-include') {
          return (
            <div key={fieldName} style={{ marginBottom: 12, fontSize: 12, color: 'var(--fg-mute, #aaa)' }}>
              ✓ <code>{fieldName}</code> — included by publisher (no override needed)
            </div>
          );
        }

        return (
          <div key={fieldName} style={{ marginBottom: 12 }}>
            <label style={lbl}>
              {fieldName}{' '}
              <span style={badge}>{reasonLabel}</span>
            </label>
            {shape.description && (
              <div style={{ fontSize: 12, color: 'var(--fg-mute, #888)', marginBottom: 4 }}>{shape.description}</div>
            )}
            {shape.oauth ? (
              <div style={{ fontSize: 13 }}>
                <em style={{ color: 'var(--fg-mute, #aaa)' }}>
                  After fork, click "Connect with {shape.oauth.provider}" on the new harness's plugin settings.
                </em>
              </div>
            ) : (
              <input
                type={shape.reason === 'secret-strip' || shape.reason === 'pattern-fallback' ? 'password' : 'text'}
                value={value}
                pattern={shape.pattern}
                onChange={(e) => onSetField(fieldName, e.target.value)}
                style={input}
                autoComplete="off"
              />
            )}
            {shape.pattern && (
              <div style={{ fontSize: 11, color: 'var(--fg-mute, #888)', marginTop: 2 }}>
                must match <code>{shape.pattern}</code>
              </div>
            )}
          </div>
        );
      })}
    </div>
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
const pluginCard: React.CSSProperties = {
  padding: 12, marginBottom: 12, border: '1px solid var(--border, #2a2a2a)',
  borderRadius: 6, background: 'rgba(255,255,255,.02)',
};
const badge: React.CSSProperties = {
  display: 'inline-block', marginLeft: 6, padding: '1px 6px', borderRadius: 3,
  fontSize: 10, fontWeight: 500, textTransform: 'uppercase',
  background: 'rgba(150,150,150,.12)', color: '#aaa', border: '1px solid rgba(150,150,150,.25)',
  letterSpacing: '.04em',
};
const primary: React.CSSProperties = {
  padding: '8px 16px', background: 'var(--accent, #58a6ff)', color: '#000',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13, fontWeight: 600,
};
const advisoryBanner: React.CSSProperties = {
  padding: 12, marginBottom: 16, borderRadius: 6,
  background: 'rgba(255, 90, 90, .1)',
  border: '1px solid rgba(255, 90, 90, .35)',
  color: '#ffb0b0',
};
