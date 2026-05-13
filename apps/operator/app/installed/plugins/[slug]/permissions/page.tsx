'use client';

import { useEffect, useMemo, useState } from 'react';
import { use } from 'react';
import { toast } from 'sonner';
import RouteLink from '../../../../_components/RouteLink';
import { Checkbox } from '../../../../harness/Checkbox';
import { explainCapability, tierBadgeColor } from '@/lib/capability-explain';

interface ManifestResp {
  name: string;
  version: string;
  description?: string | null;
  capabilities: string[];
}

interface ProjectRow { slug: string; name?: string }

export default function PluginPermissionsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const [manifest, setManifest] = useState<ManifestResp | null>(null);
  const [harnesses, setHarnesses] = useState<ProjectRow[]>([]);
  // grants[harnessSlug] = Set<capability>
  const [grants, setGrants] = useState<Record<string, Set<string>>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [mRes, pRes] = await Promise.all([
          fetch(`/api/plugins/manifest?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' }),
          fetch('/api/harness/projects', { cache: 'no-store' }),
        ]);
        if (!mRes.ok) {
          toast.error(`Plugin "${slug}" not found`);
          if (!cancelled) setLoading(false);
          return;
        }
        const m = (await mRes.json()) as ManifestResp;
        const p = pRes.ok ? await pRes.json() : { projects: [] };
        const list: ProjectRow[] = Array.isArray(p?.projects) ? p.projects : [];
        if (cancelled) return;
        setManifest(m);
        setHarnesses(list);
        // Fetch grants per harness in parallel
        const gEntries = await Promise.all(
          list.map(async (h) => {
            const r = await fetch(
              `/api/plugins/grants?plugin=${encodeURIComponent(m.name)}&version=${encodeURIComponent(m.version)}&harness=${encodeURIComponent(h.slug)}`,
              { cache: 'no-store' },
            );
            if (!r.ok) return [h.slug, new Set<string>()] as const;
            const d = await r.json();
            const caps: string[] = Array.isArray(d?.capabilities) ? d.capabilities : [];
            return [h.slug, new Set(caps)] as const;
          }),
        );
        if (cancelled) return;
        const map: Record<string, Set<string>> = {};
        for (const [h, s] of gEntries) map[h] = s;
        setGrants(map);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [slug]);

  const explained = useMemo(
    () => (manifest?.capabilities ?? []).map(explainCapability),
    [manifest],
  );

  async function toggle(harness: string, cap: string, currentlyGranted: boolean) {
    if (!manifest) return;
    const key = `${harness}:${cap}`;
    setBusy(key);
    try {
      const r = await fetch('/api/plugins/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plugin: manifest.name,
          version: manifest.version,
          harness,
          capabilities: [cap],
          action: currentlyGranted ? 'revoke' : 'grant',
          reason: 'permissions ui',
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        toast.error(`Failed to ${currentlyGranted ? 'revoke' : 'grant'}`, { description: d.error ?? 'unknown' });
        return;
      }
      setGrants((prev) => {
        const next = { ...prev };
        const set = new Set(next[harness] ?? []);
        if (currentlyGranted) set.delete(cap); else set.add(cap);
        next[harness] = set;
        return next;
      });
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return <div className="pc-shell pc-marketplace-shell"><div className="pc-card">Loading…</div></div>;
  }
  if (!manifest) {
    return (
      <div className="pc-shell pc-marketplace-shell">
        <div className="pc-card">
          Plugin <code>{slug}</code> isn't installed. <RouteLink href="/installed/plugins">Back to installed plugins</RouteLink>
        </div>
      </div>
    );
  }

  return (
    <div className="pc-shell pc-marketplace-shell">
      <section className="pc-marketplace-pagehead">
        <div>
          <p className="pc-eyebrow"><RouteLink href="/installed/plugins">Installed plugins</RouteLink> / Permissions</p>
          <h1>{manifest.name}</h1>
          <p>{manifest.description ?? 'Per-harness capability grants. The plugin can only use a capability if it is both declared in its manifest AND granted here.'}</p>
        </div>
      </section>

      {explained.length === 0 ? (
        <div className="pc-card">This plugin declares no capabilities.</div>
      ) : harnesses.length === 0 ? (
        <div className="pc-card">No harnesses registered. Create a harness first to manage grants.</div>
      ) : (
        <div className="pc-card" style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px 12px', borderBottom: '1px solid var(--border, #2a2a2a)' }}>Capability</th>
                {harnesses.map((h) => (
                  <th key={h.slug} style={{ textAlign: 'center', padding: '8px 12px', borderBottom: '1px solid var(--border, #2a2a2a)' }}>
                    <code>{h.slug}</code>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {explained.map(({ cap, label, tier }) => (
                <tr key={cap}>
                  <td style={{ padding: '10px 12px', borderBottom: '1px solid var(--border, #1a1a1a)' }}>
                    <div style={{ fontWeight: 500 }}>{label}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 }}>
                      <code style={{ fontSize: 11, opacity: 0.7 }}>{cap}</code>
                      <span style={{
                        fontSize: 10,
                        textTransform: 'uppercase',
                        padding: '1px 6px',
                        borderRadius: 3,
                        background: tierBadgeColor(tier),
                        color: 'white',
                      }}>{tier}</span>
                    </div>
                  </td>
                  {harnesses.map((h) => {
                    const granted = grants[h.slug]?.has(cap) ?? false;
                    const key = `${h.slug}:${cap}`;
                    return (
                      <td key={h.slug} style={{ textAlign: 'center', padding: '10px 12px', borderBottom: '1px solid var(--border, #1a1a1a)' }}>
                        <Checkbox
                          checked={granted}
                          disabled={busy === key}
                          onChange={() => toggle(h.slug, cap, granted)}
                          ariaLabel={`Grant ${cap} to ${h.slug}`}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
