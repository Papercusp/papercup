'use client';

import { useState } from 'react';
import { Tooltip } from './Tooltip';
import { Modal } from './Modal';
import { toast } from 'sonner';
import { ArrowRight, Check, X, Loader2 } from 'lucide-react';

interface Criteria {
  [k: string]: unknown;
}

interface PromotionItem {
  id: string;
  kind: 'promotion';
  from: string;
  to: string;
  criteria: Criteria;
  status: 'feature-freeze' | 'stabilizing' | 'ready' | 'failed' | 'promoted';
  readinessScore: number;
  readinessSummary?: string;
  summary?: string;
  ts: number;
  resolved?: boolean;
}

interface Props {
  slug: string;
  item: PromotionItem;
  onResolved: () => void;
}

export default function PromotionCard({ slug, item, onResolved }: Props) {
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  // Confirm-modal state. Two distinct flows ('confirm-low-readiness' shown
  // only when score < 1.0) so a single modal can host either prompt.
  const [confirmKind, setConfirmKind] = useState<'low-readiness' | 'cancel' | null>(null);

  const performConfirm = async () => {
    setConfirmKind(null);
    setBusy('confirm');
    try {
      const res = await fetch(`/api/harness/${slug}/promote/${item.id}/confirm`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      toast.success(`Promoted ${item.from} → ${item.to}`);
      onResolved();
    } catch (e: any) {
      toast.error(`Promotion failed: ${e.message ?? e}`);
    } finally {
      setBusy(null);
    }
  };

  const doConfirm = () => {
    // Below 100% readiness → ask before proceeding.
    if (item.readinessScore < 1.0) {
      setConfirmKind('low-readiness');
      return;
    }
    void performConfirm();
  };

  const performCancel = async () => {
    setConfirmKind(null);
    setBusy('cancel');
    try {
      const res = await fetch(`/api/harness/${slug}/reviews/${item.id}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response: 'cancelled by user' }),
      });
      if (!res.ok) throw new Error('cancel failed');
      toast.success('Promotion cancelled');
      onResolved();
    } catch (e: any) {
      toast.error(e.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  const doCancel = () => setConfirmKind('cancel');

  const scorePct = Math.round(item.readinessScore * 100);
  const ready = item.status === 'ready' || item.readinessScore >= 1.0;

  return (
    <div style={{
      padding: '10px 12px',
      background: 'color-mix(in oklab, var(--bg-2), white 3%)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${ready ? 'var(--good)' : 'var(--warn)'}`,
      borderRadius: 6,
      fontSize: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, color: 'var(--fg)' }}>Promotion</span>
        <span style={{ color: 'var(--fg-dim)' }}>{item.from}</span>
        <ArrowRight size={11} />
        <span style={{ color: 'var(--fg)' }}>{item.to}</span>
        <span style={{
          marginLeft: 'auto',
          padding: '1px 7px', fontSize: 10, borderRadius: 3,
          background: ready ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
          color: ready ? '#a7f3d0' : '#fcd34d',
          fontWeight: 600,
        }}>
          {item.status}
        </span>
      </div>

      {/* readiness bar */}
      <div style={{ marginBottom: 6 }}>
        <div style={{
          height: 4,
          background: 'var(--bg)',
          borderRadius: 2,
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${scorePct}%`,
            height: '100%',
            background: ready ? 'var(--good)' : 'var(--warn)',
            transition: 'width 400ms ease',
          }} />
        </div>
        <div style={{ fontSize: 10, color: 'var(--fg-dim)', marginTop: 2 }}>
          readiness {scorePct}%{item.readinessSummary ? ` · ${item.readinessSummary}` : ''}
        </div>
      </div>

      {/* criteria checklist */}
      <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {Object.entries(item.criteria).map(([key, val]) => {
          const met = val === true;
          return (
            <li key={key} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 10, color: 'var(--fg-dim)',
            }}>
              {met
                ? <Check size={10} style={{ color: 'var(--good)' }} />
                : <span style={{ width: 10, height: 10, borderRadius: 5, border: '1px solid var(--border)' }} />
              }
              <span style={{ fontFamily: 'ui-monospace, monospace' }}>{key}</span>
              <span>= {String(val)}</span>
            </li>
          );
        })}
      </ul>

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <Tooltip label={ready ? 'Merge and advance to the next phase' : 'Criteria not yet satisfied'}>
          <button
            onClick={doConfirm}
            disabled={!ready || !!busy}
            style={{
              padding: '3px 10px', fontSize: 11,
              background: ready ? 'var(--good)' : 'var(--border)',
              color: 'white', border: 'none', borderRadius: 3,
              cursor: ready ? 'pointer' : 'not-allowed',
              opacity: busy === 'confirm' ? 0.5 : 1,
              fontWeight: 600,
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            {busy === 'confirm' ? <Loader2 size={11} className="h-spin" /> : <Check size={11} />}
            confirm
          </button>
        </Tooltip>
        <button
          onClick={doCancel}
          disabled={!!busy}
          style={{
            padding: '3px 10px', fontSize: 11,
            background: 'transparent', color: 'var(--fg-dim)',
            border: '1px solid var(--border)', borderRadius: 3,
            cursor: busy ? 'not-allowed' : 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          <X size={11} /> cancel
        </button>
      </div>

      <Modal
        open={confirmKind !== null}
        onOpenChange={(o) => { if (!o) setConfirmKind(null); }}
        title={confirmKind === 'cancel' ? 'Cancel promotion?' : 'Proceed below 100% readiness?'}
      >
        <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
          {confirmKind === 'cancel'
            ? 'This will cancel this promotion and lift the feature freeze.'
            : `Readiness is only ${Math.round(item.readinessScore * 100)}%. Proceed anyway?`}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={() => setConfirmKind(null)}
            style={{ padding: '6px 12px', fontSize: 12, background: 'transparent', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: 3, cursor: 'pointer' }}
          >
            Keep
          </button>
          <button
            type="button"
            onClick={() => { if (confirmKind === 'cancel') void performCancel(); else void performConfirm(); }}
            style={{ padding: '6px 12px', fontSize: 12, background: confirmKind === 'cancel' ? 'var(--bad)' : 'var(--good)', color: 'white', border: 'none', borderRadius: 3, cursor: 'pointer', fontWeight: 600 }}
          >
            {confirmKind === 'cancel' ? 'Cancel promotion' : 'Proceed'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
