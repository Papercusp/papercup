const loaderPanels = Array.from({ length: 3 }, (_, index) => index);
const loaderLines = Array.from({ length: 3 }, (_, index) => index);

type ControlPlaneLoadingProps = {
  label?: string;
  mode?: 'page' | 'overlay';
};

export default function ControlPlaneLoading({
  label = 'Mission Control',
  mode = 'page',
}: ControlPlaneLoadingProps) {
  const card = (
    <section
      className={`pc-card pc-route-loading${mode === 'overlay' ? ' pc-route-loading--overlay' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={`Loading ${label}`}
    >
      <div className="pc-route-loading__grid" aria-hidden="true" />
      <div className="pc-route-loading__copy">
        <p className="pc-eyebrow">{label}</p>
        <strong className="pc-route-loading__title">Loading…</strong>
        <div className="pc-route-loading__meter" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="pc-route-loading__panels" aria-hidden="true">
        {loaderPanels.map((panel) => (
          <div key={panel} className="pc-route-loading__panel">
            <div className="pc-route-loading__panel-top">
              <span className="pc-route-loading__panel-dot" />
              <span className="pc-route-loading__panel-dot" />
              <span className="pc-route-loading__panel-dot" />
            </div>
            <div className="pc-route-loading__panel-lines">
              {loaderLines.map((line) => (
                <span key={line} className={`pc-route-loading__line pc-route-loading__line--${line + 1}`} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );

  if (mode === 'overlay') {
    return (
      <div className="pc-route-loading-overlay" aria-busy="true">
        <div className="pc-shell pc-route-loading-shell pc-route-loading-shell--overlay">{card}</div>
      </div>
    );
  }

  return (
    <div className="pc-shell pc-route-loading-shell" aria-busy="true">
      {card}
    </div>
  );
}
