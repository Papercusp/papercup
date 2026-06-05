'use client';

/**
 * ToolsSection — the Cupboard's tool-level discovery view
 * (tool-distribution-granularity-2026-06-05 P-006 / D-002 / D-005).
 *
 * Renders `GET /api/cupboard/tools`: every known tool resolved to its
 * provider — built-ins, installed plugin/pack tools, and Cupboard-installable
 * declarations (`provides_tools`). A tool never installs in isolation (D-005):
 * the install action routes to the PROVIDING listing's detail page, where the
 * existing install-consent flow executes.
 *
 * Status semantics mirror the resolver ladder:
 *   available   → usable now (chip: Built-in / Installed · <unit>)
 *   installable → a Cupboard unit provides it (button: Install <unit> → listing)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Wrench, Plug, Box, AlertTriangle, RefreshCw } from 'lucide-react';
import { COLORS, FONTS, RADIUS, SIZES } from '../harness/theme';

export interface ToolDiscoveryEntry {
  tool: string;
  status: 'available' | 'installable';
  provider: { kind: 'builtin' | 'plugin' | 'pack'; name: string; listingId?: string | null };
  unit?: {
    name: string;
    kind: 'plugin' | 'pack';
    source: 'installed' | 'cupboard';
    description?: string | null;
    version?: string | null;
    listingId?: string | null;
  };
}

interface ToolsPayload {
  tools: ToolDiscoveryEntry[];
  counts: { available: number; installable: number };
  cupboardReachable: boolean;
}

function UnitIcon({ kind, size = 11 }: { kind: 'plugin' | 'pack'; size?: number }) {
  return kind === 'pack' ? <Box size={size} /> : <Plug size={size} />;
}

export function ToolsSection({
  q,
  onOpenListing,
}: {
  /** Search text (shared with the storefront search box). */
  q: string;
  /** Open a providing listing's detail page (the act-on/install surface). */
  onOpenListing: (listingId: string) => void;
}) {
  const [payload, setPayload] = useState<ToolsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchTools = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      const res = await fetch(`/api/cupboard/tools?${params}`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ToolsPayload;
      if (!ctrl.signal.aborted) setPayload(data);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(String(err));
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    void fetchTools();
  }, [fetchTools]);

  return (
    <div data-testid="cupboard-tools-section">
      {/* Counts + degraded banner */}
      {payload && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: SIZES.sm, flexWrap: 'wrap',
            marginBottom: SIZES.md, fontFamily: FONTS.ui, fontSize: 12, color: COLORS.textMuted,
          }}
        >
          <span data-testid="cupboard-tools-counts">
            <Wrench size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            {payload.counts.available} available · {payload.counts.installable} installable
          </span>
          {!payload.cupboardReachable && (
            <span
              data-testid="cupboard-tools-degraded"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: '#fbbf24' }}
            >
              <AlertTriangle size={12} /> Cupboard unreachable — showing local tools only
            </span>
          )}
          <button
            onClick={fetchTools}
            disabled={loading}
            title="Refresh tools"
            style={{
              background: 'none', border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
              padding: '3px 7px', cursor: 'pointer', color: COLORS.textMuted, marginLeft: 'auto',
            }}
          >
            <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          </button>
        </div>
      )}

      {error && !loading && (
        <div style={{ color: '#f87171', fontSize: 12, marginBottom: SIZES.md }}>{error}</div>
      )}

      {!loading && !error && payload && payload.tools.length === 0 && (
        <div style={{ color: COLORS.textMuted, fontSize: 12, textAlign: 'center', paddingTop: 40 }}>
          No tools found{q ? ` matching "${q}"` : ''}.
        </div>
      )}

      {/* Tool rows */}
      {payload && payload.tools.length > 0 && (
        <div
          style={{
            border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
            background: COLORS.surface, overflow: 'hidden',
          }}
        >
          {payload.tools.map((t, i) => (
            <div
              key={t.tool}
              data-testid="cupboard-tool-row"
              data-tool={t.tool}
              data-status={t.status}
              style={{
                display: 'flex', alignItems: 'center', gap: SIZES.sm, flexWrap: 'wrap',
                padding: '8px 12px',
                borderTop: i === 0 ? 'none' : `1px solid ${COLORS.border}`,
              }}
            >
              <code style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.text }}>{t.tool}</code>

              {/* Provider attribution */}
              {t.provider.kind === 'builtin' ? (
                <span
                  data-testid="cupboard-tool-provider"
                  style={{
                    fontSize: 11, fontFamily: FONTS.ui, color: COLORS.textMuted,
                    border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.sm, padding: '1px 6px',
                  }}
                >
                  Built-in
                </span>
              ) : (
                <span
                  data-testid="cupboard-tool-provider"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 11, fontFamily: FONTS.ui, color: COLORS.textMuted,
                    border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.sm, padding: '1px 6px',
                  }}
                  title={t.unit?.description ?? undefined}
                >
                  <UnitIcon kind={(t.unit?.kind ?? t.provider.kind) as 'plugin' | 'pack'} />
                  {t.provider.name}
                  {t.unit?.version ? ` v${t.unit.version}` : ''}
                </span>
              )}

              {/* Status / action */}
              <span style={{ marginLeft: 'auto' }}>
                {t.status === 'available' ? (
                  <span
                    data-testid="cupboard-tool-available"
                    style={{ fontSize: 11, fontFamily: FONTS.ui, color: '#34d399' }}
                  >
                    {t.provider.kind === 'builtin' ? 'Available' : 'Installed'}
                  </span>
                ) : (
                  <button
                    data-testid="cupboard-tool-install"
                    disabled={!(t.provider.listingId ?? t.unit?.listingId)}
                    onClick={() => {
                      const id = t.provider.listingId ?? t.unit?.listingId;
                      if (id) onOpenListing(id);
                    }}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      background: COLORS.accent, color: '#fff',
                      border: `1px solid ${COLORS.accent}`, borderRadius: RADIUS.sm,
                      padding: '3px 9px', cursor: 'pointer', fontSize: 11, fontFamily: FONTS.ui,
                    }}
                  >
                    <Plug size={11} /> Install {t.provider.name}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
