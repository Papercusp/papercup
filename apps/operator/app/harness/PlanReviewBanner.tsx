'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  slug: string;
  compact?: boolean;
}

function extractVerdict(content: string): string | null {
  const match = content.match(/^VERDICT:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

const VERDICT_TONE: Record<string, { bg: string; border: string; fg: string; icon: string }> = {
  accept: { bg: '#064e3b', border: '#10b981', fg: '#a7f3d0', icon: '✓' },
  'accept-with-notes': { bg: '#1e3a8a', border: '#3b82f6', fg: '#93c5fd', icon: '◐' },
  reject: { bg: '#7f1d1d', border: '#ef4444', fg: '#fca5a5', icon: '⚠' },
};

export default function PlanReviewBanner({ slug, compact = false }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const bannerRef = useRef<HTMLDivElement | null>(null);
  const [popoverRect, setPopoverRect] = useState<{ top: number; left: number } | null>(null);

  // Position the compact-mode details popover under the banner. The compact
  // banner lives inside .h-phase-plan-row which forces `overflow: hidden`,
  // so we portal the popover to <body> instead of nesting it inside.
  useEffect(() => {
    if (!compact || !open) { setPopoverRect(null); return; }
    const update = () => {
      const r = bannerRef.current?.getBoundingClientRect();
      if (r) setPopoverRect({ top: r.bottom + 4, left: r.left });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [compact, open]);

  const load = useCallback(async () => {
    try {
      const d = await fetch(`/api/harness/${slug}/plan-review`).then((r) => r.json());
      setContent(d.content ?? null);
    } catch {
      setContent(null);
    }
  }, [slug]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (!content || dismissed) return null;
  const verdict = extractVerdict(content) ?? 'unknown';
  const key = verdict.toLowerCase().replace(/\s/g, '-');
  const tone = VERDICT_TONE[key] ?? { bg: '#1f2937', border: '#374151', fg: '#d1d5db', icon: 'ℹ' };

  return (
    <>
    <div ref={bannerRef} className={`h-plan-review-banner${compact ? ' compact' : ''}`} style={{
      background: tone.bg,
      border: `1px solid ${tone.border}`,
      borderLeft: `4px solid ${tone.border}`,
      borderRadius: 4,
      padding: compact ? '0.25rem 0.5rem' : '0.6rem 0.9rem',
      marginBottom: compact ? 0 : '0.75rem',
      fontFamily: 'system-ui, sans-serif',
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: compact ? '0.45rem' : '0.65rem', fontSize: compact ? '0.72rem' : '0.8rem', color: tone.fg, minWidth: 0 }}>
        <span style={{ fontWeight: 700 }}>{tone.icon} Plan review · <code style={{ fontFamily: 'ui-monospace, monospace' }}>{verdict}</code></span>
        <button
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Hide the plan-review markdown' : "Show the full plan-gate review (.harness/plan-review.md)"}
          style={{ background: 'transparent', border: `1px solid ${tone.border}`, color: tone.fg, borderRadius: 3, padding: '0.2rem 0.55rem', cursor: 'pointer', fontSize: '0.7rem' }}
        >
          {open ? 'hide' : 'show details'}
        </button>
        {!compact && (
          <span style={{ marginLeft: 'auto', fontFamily: 'ui-monospace, monospace', color: tone.fg, fontSize: '0.7rem', opacity: 0.75 }}>
            .harness/plan-review.md
          </span>
        )}
        <button
          onClick={() => setDismissed(true)}
          style={{ background: 'transparent', border: 'none', color: tone.fg, cursor: 'pointer', fontSize: '0.9rem', opacity: 0.7 }}
          title="Dismiss for this session"
        >
          ✕
        </button>
      </div>
      {open && !compact && (
        <pre style={{ margin: '0.5rem 0 0 0', padding: '0.5rem 0.75rem', background: '#0b0e14', color: '#d1d5db', fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem', borderRadius: 3, maxHeight: '30vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {content}
        </pre>
      )}
    </div>
    {compact && open && popoverRect && typeof document !== 'undefined' && createPortal(
      <pre style={{
        position: 'fixed',
        top: popoverRect.top, left: popoverRect.left,
        width: 'min(640px, 90vw)',
        margin: 0, padding: '0.5rem 0.75rem',
        background: '#0b0e14', color: '#d1d5db',
        fontFamily: 'ui-monospace, monospace', fontSize: '0.75rem',
        border: `1px solid ${tone.border}`, borderRadius: 4,
        boxShadow: '0 12px 28px rgba(0,0,0,0.45)',
        maxHeight: '50vh', overflow: 'auto', whiteSpace: 'pre-wrap',
        zIndex: 90,
      }}>
        {content}
      </pre>,
      document.body,
    )}
    </>
  );
}
