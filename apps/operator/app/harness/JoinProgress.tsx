'use client';

/**
 * JoinProgress — 9-step progress UI for Entry 4 harness-link join (P-009).
 *
 * Renders each step from the `join-shared-harness` orchestrator with
 * pending / running / done / error / phase_0_pending status indicators
 * and human-readable copy per step.
 */

import type { JoinStepId, JoinStepState, JoinStepStatus } from '../../lib/harness/join-shared-harness';

// ─── step metadata ─────────────────────────────────────────────────────────

const STEP_META: Record<JoinStepId, { label: string; detail: string }> = {
  oauth_attest: {
    label: 'Verify GitHub identity',
    detail: 'Checking your OAuth token and device keypair.',
  },
  clone_repo: {
    label: 'Clone repository',
    detail: 'Downloading the shared GitHub repository.',
  },
  join_hyperswarm: {
    label: 'Join peer network',
    detail: 'Connecting to the Hyperswarm peer-to-peer topic.',
  },
  bootstrap_hyperbee: {
    label: 'Sync harness data',
    detail: 'Replicating the Autobase from connected peers.',
  },
  seed_pg: {
    label: 'Seed local database',
    detail: 'Writing the replicated state into local Postgres.',
  },
  create_user_branch: {
    label: 'Create your branch',
    detail: 'Setting up your user/<id> contributor branch.',
  },
  push_contributor_file: {
    label: 'Publish contributor file',
    detail: 'Signing and pushing .harness/contributors/<login>.json.',
  },
  publish_binding: {
    label: 'Announce to peers',
    detail: 'Publishing your contributor binding to the shared log.',
  },
  verify_binding: {
    label: 'Verify binding',
    detail: 'Confirming two-channel identity verification.',
  },
  route_insights: {
    label: 'Done',
    detail: 'Opening the Insights tab for your new harness.',
  },
};

const STEP_ORDER: JoinStepId[] = [
  'oauth_attest',
  'clone_repo',
  'join_hyperswarm',
  'bootstrap_hyperbee',
  'seed_pg',
  'create_user_branch',
  'push_contributor_file',
  'publish_binding',
  'verify_binding',
  'route_insights',
];

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
