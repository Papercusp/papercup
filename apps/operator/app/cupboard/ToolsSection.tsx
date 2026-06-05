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

const toolRefreshStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(15,20,32,0.72)',
  border: `1px solid ${COLORS.border}`,
  borderRadius: 999,
  padding: '7px 10px',
  cursor: 'pointer',
  color: COLORS.textMuted,
};

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
            marginBottom: SIZES.md,
            padding: 12,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.lg,
            background: 'rgba(15,20,32,0.82)',
            fontFamily: FONTS.ui,
            fontSize: 12,
            color: COLORS.textMuted,
          }}
        >
          <span
            data-testid="cupboard-tools-counts"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: COLORS.text }}
          >
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
            style={{ ...toolRefreshStyle, marginLeft: 'auto' }}
          >
            <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
          </button>
        </div>
      )}

      {error && !loading && (
        <div style={{ color: '#fca5a5', fontSize: 12, marginBottom: SIZES.md, padding: 12, border: '1px solid rgba(239,68,68,0.24)', borderRadius: RADIUS.lg, background: 'rgba(127,29,29,0.16)' }}>{error}</div>
      )}

      {!loading && !error && payload && payload.tools.length === 0 && (
        <div style={{ color: COLORS.textMuted, fontSize: 12, textAlign: 'center', padding: '44px 18px', border: `1px dashed ${COLORS.borderStrong}`, borderRadius: RADIUS.lg, background: 'rgba(15,20,32,0.48)' }}>
          No tools found{q ? ` matching "${q}"` : ''}.
        </div>
      )}

      {/* Tool rows */}
      {payload && payload.tools.length > 0 && (
        <div
          style={{
            border: `1px solid ${COLORS.border}`,
            borderRadius: 14,
            background: 'linear-gradient(180deg, rgba(17,24,39,0.96), rgba(15,20,32,0.92))',
            overflow: 'hidden',
            boxShadow: '0 18px 42px rgba(0,0,0,0.22)',
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
                padding: '12px 14px',
                borderTop: i === 0 ? 'none' : `1px solid ${COLORS.border}`,
              }}
            >
              <code style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.text, background: 'rgba(11,14,20,0.42)', border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: '3px 8px' }}>{t.tool}</code>

              {/* Provider attribution */}
              {t.provider.kind === 'builtin' ? (
                <span
                  data-testid="cupboard-tool-provider"
                  style={{
                    fontSize: 11, fontFamily: FONTS.ui, color: COLORS.textMuted,
                    border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: '3px 8px',
                    background: 'rgba(11,14,20,0.28)',
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
                    border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: '3px 8px',
                    background: 'rgba(11,14,20,0.28)',
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
                    style={{ fontSize: 11, fontFamily: FONTS.ui, color: COLORS.successText, border: '1px solid rgba(16,185,129,0.22)', background: 'rgba(16,185,129,0.10)', borderRadius: 999, padding: '3px 8px' }}
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
                      background: `linear-gradient(135deg, ${COLORS.accent}, ${COLORS.accentHover})`,
                      color: '#fff',
                      border: '1px solid rgba(255,255,255,0.16)',
                      borderRadius: 999,
                      padding: '5px 10px',
                      cursor: 'pointer',
                      fontSize: 11,
                      fontFamily: FONTS.ui,
                      boxShadow: '0 10px 22px rgba(94,106,210,0.20)',
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
