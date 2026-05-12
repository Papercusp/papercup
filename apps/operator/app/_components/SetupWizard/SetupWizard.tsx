'use client';

import { useQueryState } from 'nuqs';
import { useEffect, useMemo } from 'react';
import { SETUP_STEPS, findStep } from './steps';
import type { StepStatus } from './types';
import { StepAgents } from './StepAgents';
import { StepEmbeddedPg } from './StepEmbeddedPg';
import { StepPlaceholder } from './StepPlaceholder';
import { useWizardStatuses } from './useWizardStatuses';

interface Props {
  readonly mode: 'first-run' | 'settings';
}

export function SetupWizard({ mode }: Props) {
  const [stepId, setStepId] = useQueryState('step', { defaultValue: SETUP_STEPS[0].id });
  const { statuses, refreshAll } = useWizardStatuses();

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const active = useMemo(() => findStep(stepId) ?? SETUP_STEPS[0], [stepId]);

  return (
    <div className="pc-setup-wizard" data-mode={mode}>
      <aside className="pc-setup-wizard__sidebar">
        <h2 className="pc-setup-wizard__title">Setup Wizard</h2>
        <p className="pc-setup-wizard__subtitle">
          {mode === 'first-run'
            ? 'Welcome to Papercusp. Run through these steps to get set up.'
            : 'Configure or revisit any step. Detection runs automatically.'}
        </p>
        <ol className="pc-setup-wizard__steps">
          {SETUP_STEPS.map((s, idx) => {
            const status: StepStatus = statuses[s.id] ?? 'unknown';
            const isActive = s.id === active.id;
            return (
              <li
                key={s.id}
                className="pc-setup-wizard__step"
                data-active={isActive ? 'true' : undefined}
                data-status={status}
              >
                <button
                  type="button"
                  className="pc-setup-wizard__step-btn"
                  onClick={() => setStepId(s.id)}
                >
                  <span className="pc-setup-wizard__step-num">{idx + 1}</span>
                  <span className="pc-setup-wizard__step-text">
                    <span className="pc-setup-wizard__step-title">{s.title}</span>
                    <span className="pc-setup-wizard__step-summary">{s.summary}</span>
                  </span>
                  <StatusBadge status={status} required={s.required} />
                </button>
              </li>
            );
          })}
        </ol>
      </aside>

      <main className="pc-setup-wizard__main">
        <header className="pc-setup-wizard__main-header">
          <h1>{active.title}</h1>
          <p>{active.summary}</p>
        </header>
        <section className="pc-setup-wizard__main-body">{renderStep(active.id)}</section>
      </main>
    </div>
  );
}

function renderStep(id: string) {
  switch (id) {
    case 'embedded-pg':
      return <StepEmbeddedPg />;
    case 'agents':
      return <StepAgents />;
    default:
      return <StepPlaceholder id={id} />;
  }
}

function StatusBadge({ status, required }: { status: StepStatus; required?: boolean }) {
  const label = {
    ok: '✓',
    'needs-attention': '!',
    skipped: '—',
    unknown: '·',
    'in-progress': '…',
  }[status];
  return (
    <span className="pc-setup-wizard__status" data-status={status} data-required={required ? 'true' : undefined}>
      {label}
    </span>
  );
}
