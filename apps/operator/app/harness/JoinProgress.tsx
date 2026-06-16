'use client';

/**
 * JoinProgress — 6-step progress UI for Entry 4 harness-link join (P-009, D-005).
 *
 * Renders each step from the `join-shared-harness` orchestrator with
 * pending / running / done / error / phase_0_pending status indicators
 * and human-readable copy per step.
 *
 * Step list sourced from JOIN_STEP_IDS (canonical — cannot drift from orchestrator).
 */

// Import the step vocabulary from the dependency-free leaf, NOT join-shared-harness
// (which pulls node:child_process/fs/os + the identity chain into the SPA bundle).
import { JOIN_STEP_IDS } from '@papercusp/operator-core/lib/harness/join-steps';
import type { JoinStepId, JoinStepState, JoinStepStatus } from '@papercusp/operator-core/lib/harness/join-steps';
import type { BoundLexicon } from '@papercusp/lexicon';
import { useLexicon } from '@/lib/useLexicon';

// ─── step metadata ─────────────────────────────────────────────────────────

function buildStepMeta(t: BoundLexicon): Record<JoinStepId, { label: string; detail: string }> {
  return {
    oauth_attest: {
      label: 'Authenticating with GitHub',
      detail: 'Checking your OAuth token and device keypair.',
    },
    clone_repo: {
      label: 'Cloning repository',
      detail: 'Downloading the shared GitHub repository.',
    },
    publish_binding: {
      label: 'Publishing your binding',
      detail: 'Signing and publishing your contributor file via GitHub.',
    },
    boot_federate: {
      label: 'Joining the swarm',
      detail: 'Booting the Model B federation substrate.',
    },
    await_admission_merge: {
      label: 'Syncing with peers',
      detail: 'Waiting for a remote peer to admit and merge.',
    },
    route_insights: {
      label: 'Opening insights',
      detail: `Opening the Insights tab for your new ${t('pot', { lower: true })}.`,
    },
  };
}

const STEP_ORDER: JoinStepId[] = JOIN_STEP_IDS;

// ─── status icon ──────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: JoinStepStatus }) {
  if (status === 'done') {
    return <span style={{ color: 'var(--success, #22c55e)', fontWeight: 700 }}>✓</span>;
  }
  if (status === 'running') {
    return (
      <span
        style={{
          display: 'inline-block',
          width: 14,
          height: 14,
          border: '2px solid var(--accent, #6366f1)',
          borderTopColor: 'transparent',
          borderRadius: '50%',
          animation: 'spin 0.7s linear infinite',
        }}
      />
    );
  }
  if (status === 'error') {
    return <span style={{ color: 'var(--error, #ef4444)', fontWeight: 700 }}>✕</span>;
  }
  if (status === 'phase_0_pending') {
    return <span style={{ color: 'var(--fg-dim, #888)', fontSize: 11 }}>—</span>;
  }
  // pending
  return <span style={{ color: 'var(--fg-dim, #888)' }}>○</span>;
}

// ─── step row ─────────────────────────────────────────────────────────────────

function StepRow({ step }: { step: JoinStepState }) {
  const meta = STEP_META[step.id];
  const isActive = step.status === 'running';
  const isDimmed = step.status === 'pending' || step.status === 'phase_0_pending';
  const isPhase0 = step.status === 'phase_0_pending';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '6px 0',
        opacity: isDimmed ? 0.5 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      <span
        style={{
          width: 18,
          minWidth: 18,
          textAlign: 'center',
          marginTop: 1,
          fontSize: 13,
          lineHeight: 1,
        }}
      >
        <StatusIcon status={step.status} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: isActive ? 600 : 400,
            color: isActive ? 'var(--fg, inherit)' : 'inherit',
          }}
        >
          {meta.label}
          {isPhase0 && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'var(--bg-3, #444)',
                color: 'var(--fg-dim, #888)',
                fontWeight: 400,
                verticalAlign: 'middle',
              }}
            >
              Phase 5
            </span>
          )}
        </div>
        {step.status === 'running' && (
          <div style={{ fontSize: 11, color: 'var(--fg-dim, #888)', marginTop: 2 }}>
            {meta.detail}
          </div>
        )}
        {step.status === 'error' && step.errorCode && (
          <div style={{ fontSize: 11, color: 'var(--error, #ef4444)', marginTop: 2 }}>
            {step.detail ?? step.errorCode}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

export interface JoinProgressProps {
  steps: JoinStepState[];
  /** When set, shows a "Open harness" button that navigates to insights. */
  insightsPath?: string;
  /** Error message if the join failed entirely. */
  fatalError?: string;
}

export function JoinProgress({ steps, insightsPath, fatalError }: JoinProgressProps) {
  const stepMap: Partial<Record<JoinStepId, JoinStepState>> = {};
  for (const s of steps) stepMap[s.id] = s;

  const isDone = insightsPath != null;

  return (
    <div>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>

      <div
        style={{
          background: 'var(--bg-2, #1e1e2e)',
          border: '1px solid var(--border, #3f3f5a)',
          borderRadius: 8,
          padding: '14px 16px',
        }}
      >
        {STEP_ORDER.map((id) => {
          const step = stepMap[id] ?? { id, status: 'pending' as JoinStepStatus };
          return <StepRow key={id} step={step} />;
        })}
      </div>

      {fatalError && (
        <div
          style={{
            marginTop: 12,
            padding: '10px 14px',
            background: 'var(--error-bg, rgba(239,68,68,0.1))',
            border: '1px solid var(--error, #ef4444)',
            borderRadius: 6,
            color: 'var(--error, #ef4444)',
            fontSize: 13,
          }}
        >
          {fatalError}
        </div>
      )}

      {isDone && (
        <div style={{ marginTop: 14, textAlign: 'right' }}>
          <a
            href={insightsPath}
            style={{
              display: 'inline-block',
              padding: '7px 16px',
              fontSize: 13,
              fontWeight: 600,
              background: 'var(--accent, #6366f1)',
              color: '#fff',
              borderRadius: 5,
              textDecoration: 'none',
            }}
          >
            Open harness →
          </a>
        </div>
      )}
    </div>
  );
}
