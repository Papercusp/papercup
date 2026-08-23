import type { ExternalTriggerBindingAdminRow } from '@papercusp/operator-core/lib/external-triggers/admin';

export function numberFromPolicy(
  policy: Record<string, unknown>,
  camel: string,
  snake: string,
): number | null {
  const value = policy[camel] ?? policy[snake];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function formatTriggerTime(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function compactTriggerJson(value: Record<string, unknown>): string {
  return Object.keys(value).length === 0 ? 'none' : JSON.stringify(value);
}

export function TriggerBindingCard({
  binding,
  busy,
  showPlan = true,
  onSetArmed,
  onStormPolicy,
  onDetach,
}: {
  binding: ExternalTriggerBindingAdminRow;
  busy: boolean;
  showPlan?: boolean;
  onSetArmed: (binding: ExternalTriggerBindingAdminRow, armed: boolean) => void;
  onStormPolicy?: (binding: ExternalTriggerBindingAdminRow) => void;
  onDetach?: (binding: ExternalTriggerBindingAdminRow) => void;
}) {
  const policyMax = numberFromPolicy(binding.stormPolicy, 'maxRuns', 'max_runs');
  const policyWindow =
    numberFromPolicy(binding.stormPolicy, 'windowSeconds', 'window_seconds') ?? 60;
  return (
    <article className={`tr-card${binding.armed ? '' : ' muted'}`}>
      <div className="tr-card-main">
        <div className="tr-card-heading">
          <code>{binding.eventPattern}</code>
          <span className="tr-badge">{binding.sourceKind}</span>
          <span className={`tr-badge status-${binding.sourceStatus}`}>
            {binding.sourceStatus}
          </span>
        </div>
        {showPlan ? (
          <div className="tr-meta">
            → {binding.planHarnessSlug}/{binding.planSlug}
          </div>
        ) : null}
        <div className="tr-meta">filter: {compactTriggerJson(binding.eventFilter)}</div>
        <div className="tr-meta">
          storm:{' '}
          {policyMax === null
            ? 'unbounded'
            : `${policyMax} run${policyMax === 1 ? '' : 's'}`}{' '}
          / {policyWindow}s
        </div>
        <div className="tr-meta">
          last run:{' '}
          {binding.lastRun
            ? `${binding.lastRun.status} · ${formatTriggerTime(binding.lastRun.triggeredAt)}`
            : 'never'}
          {binding.lastRun?.error ? ` · ${binding.lastRun.error}` : ''}
        </div>
      </div>
      <div className="tr-card-actions">
        <button
          type="button"
          role="switch"
          aria-checked={binding.armed}
          aria-label={`${binding.armed ? 'Disarm' : 'Arm'} ${binding.eventPattern}`}
          className={`tr-switch${binding.armed ? ' on' : ''}`}
          disabled={busy}
          onClick={() => onSetArmed(binding, !binding.armed)}
        >
          <span />
        </button>
        <strong className={binding.armed ? 'tr-good' : ''}>
          {binding.armed ? 'Armed' : 'Off'}
        </strong>
        {onStormPolicy ? (
          <button type="button" className="tr-link" onClick={() => onStormPolicy(binding)}>
            Storm policy
          </button>
        ) : null}
        {onDetach ? (
          <button
            type="button"
            className="tr-link tr-link-danger"
            disabled={busy}
            onClick={() => onDetach(binding)}
          >
            Detach
          </button>
        ) : null}
      </div>
    </article>
  );
}
