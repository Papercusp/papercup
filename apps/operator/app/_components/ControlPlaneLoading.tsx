const statLabels = ['pulse', 'passed', '$ spent', 'lanes'];
const tabs = ['brainstorm', 'proposals', 'experts', 'dashboard', 'summary', 'insights', 'config'];
const tabAccentClass: Record<string, string> = {
  brainstorm: 'h-tab--brainstorm',
  proposals: 'h-tab--proposals',
  dashboard: 'h-tab--dashboard',
  summary: 'h-tab--summary',
  experts: 'h-tab--experts',
  insights: 'h-tab--insights',
  config: 'h-tab--config',
};
const filterLabels = ['All', 'Running', 'Blocked'];
const featureRows = Array.from({ length: 5 }, (_, index) => index);
const agentRows = Array.from({ length: 4 }, (_, index) => index);
const logRows = Array.from({ length: 7 }, (_, index) => index);

type ControlPlaneLoadingProps = {
  label?: string;
  mode?: 'page' | 'overlay';
};

function LoadingPanel({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={[ 'h-panel', 'h-loading-panel', className ].filter(Boolean).join(' ')}>
      <div className="h-panel-head">
        <span className="h-panel-title">{title}</span>
        <span className="h-panel-count h-loading-count" aria-hidden="true" />
      </div>
      <div className="h-panel-body">{children}</div>
    </section>
  );
}

export default function ControlPlaneLoading({
  label = 'Mission Control',
  mode = 'page',
}: ControlPlaneLoadingProps) {
  const shell = (
    <div className={`h-root h-loading-root${mode === 'overlay' ? ' h-loading-root--overlay' : ''}`} aria-busy="true">
      <span className="pc-sr-only" role="status" aria-live="polite">Loading {label}</span>

      <div className="h-header">
        <div className="h-header-main">
          <div className="h-project-card h-loading-surface">
            <div className="h-project-topline">
              <div className="h-project-phases h-loading-phase-list" aria-hidden="true">
                <span className="h-loading-phase-pill" />
                <span className="h-loading-phase-pill h-loading-phase-pill--short" />
                <span className="h-loading-phase-pill" />
              </div>
              <div className="h-project-badges" aria-hidden="true">
                <span className="h-status-chip h-loading-badge">
                  <span className="h-pulse-dot live" />
                  <span className="h-loading-block h-loading-block--badge" />
                </span>
              </div>
            </div>

            <div className="h-project h-loading-project" aria-hidden="true">
              <span className="h-loading-block h-loading-block--project" />
              <span className="h-loading-caret" />
            </div>

            <div className="h-project-meta" aria-hidden="true">
              <span className="h-project-path">
                <span className="h-loading-block h-loading-block--path" />
              </span>
              <span className="h-project-meta-status h-loading-meta-status">
                <span className="h-loading-block h-loading-block--meta" />
                <span className="h-loading-block h-loading-block--meta h-loading-block--meta-short" />
                <span className="h-loading-block h-loading-block--meta" />
              </span>
            </div>
          </div>
        </div>

        <div className="h-header-side">
          <div className="h-stats" aria-hidden="true">
            {statLabels.map((stat) => (
              <div key={stat} className="h-stat h-loading-surface">
                <span className="h-stat-label">{stat}</span>
                <span className="h-stat-value">
                  <span className="h-loading-block h-loading-block--stat" />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="h-quick-action-row h-loading-quick-row" aria-hidden="true">
        <div className="h-quick-action-copy">
          <span className="h-loading-block h-loading-block--quick-label" />
          <strong className="h-loading-block h-loading-block--quick-title" />
        </div>
        <div className="h-loading-quick-actions">
          <span className="h-loading-quick-chip" />
          <span className="h-loading-quick-chip" />
          <span className="h-loading-quick-chip" />
        </div>
      </div>

      <div className="h-tabs h-main-tabs" aria-hidden="true">
        {tabs.map((tab) => (
          <span key={tab} className={`h-tab ${tabAccentClass[tab] ?? 'h-tab--plugin'}${tab === 'dashboard' ? ' on' : ''} h-loading-tab`}>
            {tab}
          </span>
        ))}
      </div>

      <div className="h-main-shell dashboard h-loading-main-shell">
        <div className="h-loading-dashboard-grid">
          <LoadingPanel title="Feature queue" className="h-loading-panel--queue">
            <div className="h-feature-toolbar h-loading-surface h-loading-feature-toolbar" aria-hidden="true">
              <div className="h-feature-viewbar">
                {filterLabels.map((filter, index) => (
                  <span key={filter} className={`h-feature-filter${index === 0 ? ' active' : ''}`}>
                    {filter}
                    <strong>0</strong>
                  </span>
                ))}
              </div>
              <div className="h-feature-toolrow h-loading-feature-toolrow">
                <div className="h-feature-search">
                  <span className="h-loading-block h-loading-block--search" />
                </div>
                <div className="h-feature-mode">
                  <span className="h-feature-mode-btn active">list</span>
                  <span className="h-feature-mode-btn">board</span>
                </div>
                <span className="h-feature-add">+ new</span>
              </div>
            </div>
            <div className="h-loading-panel-stack" aria-hidden="true">
              {featureRows.map((row) => (
                <div key={row} className="h-feature-row compact h-loading-feature-row">
                  <div className="h-loading-feature-main">
                    <span className="h-loading-block h-loading-block--feature-title" />
                    <span className="h-loading-block h-loading-block--feature-meta" />
                  </div>
                  <div className="h-feature-row-actions h-loading-feature-actions">
                    <span className="h-loading-feature-action" />
                    <span className="h-loading-feature-action" />
                    <span className="h-loading-feature-action" />
                  </div>
                </div>
              ))}
            </div>
          </LoadingPanel>

          <LoadingPanel title="Recent agents" className="h-loading-panel--agents">
            <div className="h-loading-panel-stack h-loading-agent-stack" aria-hidden="true">
              {agentRows.map((row) => (
                <div key={row} className="h-loading-agent-row">
                  <span className="h-loading-agent-dot" />
                  <span className="h-loading-block h-loading-block--agent-role" />
                  <span className="h-loading-block h-loading-block--agent-run" />
                  <span className="h-loading-block h-loading-block--agent-time" />
                </div>
              ))}
            </div>
          </LoadingPanel>

          <LoadingPanel title="run.log" className="h-loading-panel--log">
            <div className="h-log-container" aria-hidden="true">
              <div className="h-log-toolbar">
                <span className="h-log-toolbar-btn h-loading-log-chip" />
                <span className="h-log-toolbar-btn h-loading-log-chip" />
                <span className="h-log-pause-toggle h-loading-log-chip" />
              </div>
              <div className="h-log h-log-body h-loading-log-body">
                {logRows.map((row) => (
                  <div key={row} className="h-log-line kind-iteration h-loading-log-line">
                    <span className="h-log-ts"><span className="h-loading-block h-loading-block--log-ts" /></span>
                    <span className="h-log-tag"><span className="h-loading-block h-loading-block--log-tag" /></span>
                    <span className="h-log-msg"><span className="h-loading-block h-loading-block--log-msg" /></span>
                  </div>
                ))}
              </div>
            </div>
          </LoadingPanel>
        </div>
      </div>
    </div>
  );

  return mode === 'overlay' ? <div className="h-loading-overlay">{shell}</div> : shell;
}
