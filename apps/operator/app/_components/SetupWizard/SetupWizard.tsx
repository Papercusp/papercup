'use client';

import { useQueryState } from 'nuqs';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { SETUP_STEPS, findStep } from './steps';
import type { StepStatus } from './types';
import { StepAgents } from './StepAgents';
import { StepAutoUpdate } from './StepAutoUpdate';
import { StepBackups } from './StepBackups';
import { StepEmbeddedPg } from './StepEmbeddedPg';
import { StepGit } from './StepGit';
import { StepKeys } from './StepKeys';
import { StepLogins } from './StepLogins';
import { StepMobilePairing } from './StepMobilePairing';
import { StepOsPermissions } from './StepOsPermissions';
import { StepPlaceholder } from './StepPlaceholder';
import { StepTelemetry } from './StepTelemetry';
import { StepVoiceDevices } from './StepVoiceDevices';
import { StepWelcome } from './StepWelcome';
import { StepWorkspace } from './StepWorkspace';
import { useWizardStatuses } from './useWizardStatuses';

interface Props {
  readonly mode: 'first-run' | 'settings';
}

export function SetupWizard({ mode }: Props) {
  const router = useRouter();
  const { statuses, persisted, voiceConfigured, refreshAll, setStepPersistedStatus, setLastVisitedStep } =
    useWizardStatuses();
  const [stepId, setStepId] = useQueryState('step');
  const [finishing, setFinishing] = useState(false);
  const [recap, setRecap] = useState<null | { dest: string }>(null);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (stepId) void setLastVisitedStep(stepId);
  }, [stepId, setLastVisitedStep]);

  // In first-run mode with no ?step= and no prior visit, show the
  // welcome card. In settings mode, jump straight to the first step
  // (the welcome card is meant for the un-onboarded user, not someone
  // dipping in from Settings).
  const showWelcome = mode === 'first-run' && !stepId && !persisted.last_visited_step;
  const active = useMemo(
    () => findStep(stepId) ?? findStep(persisted.last_visited_step) ?? SETUP_STEPS[0],
    [stepId, persisted.last_visited_step],
  );

  const isDismissed = persisted.step_status?.[active.id] === 'dismissed';
  const isCompleted = persisted.step_status?.[active.id] === 'completed';

  // Minimum to finish setup: ≥1 coding agent installed + embedded-pg
  // ready. Workspace path is recorded server-side regardless of
  // wizard interaction (default `~/.papercusp/projects/` always
  // works), so it isn't part of the gate.
  const minimumMet =
    statuses['embedded-pg'] === 'ok' && statuses['agents'] === 'ok';

  const idx = SETUP_STEPS.findIndex((s) => s.id === active.id);

  const stepCount = SETUP_STEPS.length;
  const currentStepNumber = Math.max(idx, 0) + 1;
  const progressPct = Math.round((currentStepNumber / stepCount) * 100);
  const hasNextStep = idx < SETUP_STEPS.length - 1;
  // Step 8 (voice-devices) is only useful when the user actually
  // plans to use voice. We treat "ElevenLabs key is set" as the proxy
  // for that — the Next button skips voice-devices when not
  // configured (it stays reachable from the sidebar). Settings-mode
  // never auto-skips.
  const shouldSkip = (id: string): boolean =>
    mode === 'first-run' && id === 'voice-devices' && !voiceConfigured;
  const goNext = () => {
    for (let i = idx + 1; i < SETUP_STEPS.length; i++) {
      const next = SETUP_STEPS[i];
      if (!shouldSkip(next.id)) {
        setStepId(next.id);
        return;
      }
    }
  };
  const goPrev = () => {
    for (let i = idx - 1; i >= 0; i--) {
      const prev = SETUP_STEPS[i];
      if (!shouldSkip(prev.id)) {
        setStepId(prev.id);
        return;
      }
    }
  };

  const finishWizard = async () => {
    setFinishing(true);
    try {
      await fetch('/api/desktop/setup-wizard-state', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ finished_at: new Date().toISOString() }),
      });
      if (mode === 'first-run') {
        // Land on /marketplace when the workspace is empty — landing on
        // /harness with no harnesses is a confusing dead-end. Once at
        // least one template is installed, /harness is the right home.
        let dest = '/harness';
        try {
          const r = await fetch('/api/installed', { cache: 'no-store' });
          if (r.ok) {
            const j = (await r.json()) as { projects?: unknown[] };
            const count = Array.isArray(j.projects) ? j.projects.length : 0;
            if (count === 0) dest = '/marketplace';
          }
        } catch {
          // Network failure → fall through to /harness.
        }
        // Show a recap card before redirecting so the user sees a
        // confirmation of what just got set up. The card's CTA is what
        // actually does the router.push.
        setRecap({ dest });
        setFinishing(false);
      } else {
        setFinishing(false);
      }
    } catch {
      setFinishing(false);
    }
  };

  if (recap) {
    const completed = SETUP_STEPS.filter(
      (s) =>
        statuses[s.id] === 'ok' || persisted.step_status?.[s.id] === 'completed',
    );
    return (
      <div className="pc-setup-wizard pc-setup-wizard--recap" data-mode={mode}>
        <div className="pc-step pc-step--recap">
          <h2 className="pc-step__lead" style={{ fontSize: 24, marginBottom: 8 }}>
            You're all set.
          </h2>
          <p className="pc-step__lead">
            Setup finished — {completed.length} of {SETUP_STEPS.length} steps confirmed ready.
            Anything you skipped, you can revisit any time from Settings → Setup Wizard.
          </p>
          <ul className="pc-bullets">
            {completed.slice(0, 6).map((s) => (
              <li key={s.id}>{s.title}</li>
            ))}
          </ul>
          <div className="pc-step__actions">
            <button
              type="button"
              className="pc-btn pc-btn--primary"
              onClick={() => router.push(recap.dest)}
            >
              {recap.dest === '/marketplace'
                ? 'Continue to marketplace →'
                : 'Continue to harness →'}
            </button>
          </div>
        </div>
      </div>
    );
  }

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
          {SETUP_STEPS.map((s, i) => {
            const status: StepStatus = statuses[s.id] ?? 'unknown';
            const isActive = !showWelcome && s.id === active.id;
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
                  <span className="pc-setup-wizard__step-num">{i + 1}</span>
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
        <div className="pc-setup-wizard__sidebar-footer">
          <div className="pc-setup-wizard__min" data-met={minimumMet ? 'true' : 'false'}>
            <span className="pc-setup-wizard__min-dot" />
            <span>
              {minimumMet
                ? 'Minimum setup complete — you can finish any time.'
                : 'Required: ≥1 coding agent + local database ready.'}
            </span>
          </div>
        </div>
      </aside>

      <main className="pc-setup-wizard__main">
        {showWelcome ? (
          <StepWelcome onStart={() => setStepId(SETUP_STEPS[0].id)} />
        ) : (
          <>
            <header className="pc-setup-wizard__main-header">
              <div className="pc-setup-wizard__eyebrow">
                <span>Step {currentStepNumber} of {stepCount}</span>
                <span className="pc-setup-wizard__pill">{active.required ? 'Required' : 'Optional'}</span>
              </div>
              <h1>{active.title}</h1>
              <p>{active.summary}</p>
              <div className="pc-setup-wizard__progress" aria-hidden="true">
                <span style={{ width: `${progressPct}%` }} />
              </div>
            </header>
            <section className="pc-setup-wizard__main-body">{renderStep(active.id)}</section>
            <footer className="pc-setup-wizard__main-footer">
              <div className="pc-setup-wizard__main-footer-left">
                {idx > 0 && (
                  <button type="button" className="pc-btn" onClick={goPrev}>
                    ← Back
                  </button>
                )}
                {!active.required && !isDismissed && !isCompleted && (
                  <button
                    type="button"
                    className="pc-btn"
                    onClick={() => void setStepPersistedStatus(active.id, 'dismissed')}
                  >
                    Skip this step
                  </button>
                )}
                {isDismissed && (
                  <span className="pc-setup-wizard__skip-note">
                    Skipped.{' '}
                    <button
                      type="button"
                      className="pc-link-btn"
                      onClick={() => void setStepPersistedStatus(active.id, null)}
                    >
                      Un-skip
                    </button>
                  </span>
                )}
                {!active.required &&
                  !isCompleted &&
                  active.id !== 'embedded-pg' &&
                  active.id !== 'agents' &&
                  active.id !== 'telemetry' && (
                    <button
                      type="button"
                      className="pc-btn"
                      onClick={() => void setStepPersistedStatus(active.id, 'completed')}
                    >
                      Mark as done
                    </button>
                  )}
                {isCompleted && (
                  <span className="pc-setup-wizard__skip-note">
                    Done.{' '}
                    <button
                      type="button"
                      className="pc-link-btn"
                      onClick={() => void setStepPersistedStatus(active.id, null)}
                    >
                      Reset
                    </button>
                  </span>
                )}
              </div>
              <div className="pc-setup-wizard__main-footer-right">
                {hasNextStep && (
                  <button type="button" className="pc-btn pc-btn--primary" onClick={goNext}>
                    Continue →
                  </button>
                )}
                {minimumMet ? (
                  <button
                    type="button"
                    className={`pc-btn${hasNextStep ? '' : ' pc-btn--primary'}`}
                    onClick={() => void finishWizard()}
                    disabled={finishing}
                  >
                    {finishing
                      ? 'Finishing…'
                      : mode === 'first-run'
                        ? 'Finish setup'
                        : 'Mark setup complete'}
                  </button>
                ) : (
                  <span className="pc-setup-wizard__finish-hint">
                    Finish unlocks after the database and a coding agent are ready.
                  </span>
                )}
              </div>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

function renderStep(id: string) {
  switch (id) {
    case 'os-permissions':
      return <StepOsPermissions />;
    case 'embedded-pg':
      return <StepEmbeddedPg />;
    case 'workspace':
      return <StepWorkspace />;
    case 'agents':
      return <StepAgents />;
    case 'logins':
      return <StepLogins />;
    case 'keys':
      return <StepKeys />;
    case 'git':
      return <StepGit />;
    case 'voice-devices':
      return <StepVoiceDevices />;
    case 'mobile-pairing':
      return <StepMobilePairing />;
    case 'backups':
      return <StepBackups />;
    case 'auto-update':
      return <StepAutoUpdate />;
    case 'telemetry':
      return <StepTelemetry />;
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
