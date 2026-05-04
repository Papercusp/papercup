import { HudReticleGlyph, HudTelemetryMarquee } from './HudPrimitives';

type OperatorOverlayState = 'idle' | 'scanning' | 'thinking' | 'acting' | 'paused' | 'awaiting-input';

type OperatorScanOverlayProps = {
  state: OperatorOverlayState;
  pendingCount: number;
  inFlightCount: number;
  failedCount: number;
  reducedMotion?: boolean;
};

const STATE_LABEL: Record<OperatorOverlayState, string> = {
  idle: 'standby grid',
  scanning: 'scan net',
  thinking: 'synthesis pulse',
  acting: 'dispatch relay',
  paused: 'suspend guard',
  'awaiting-input': 'review lock',
};

export function OperatorScanOverlay({
  state,
  pendingCount,
  inFlightCount,
  failedCount,
  reducedMotion = false,
}: OperatorScanOverlayProps) {
  const marquee = [
    `state:${STATE_LABEL[state]}`,
    `pending:${String(pendingCount).padStart(2, '0')}`,
    `transit:${String(inFlightCount).padStart(2, '0')}`,
    `alerts:${String(failedCount).padStart(2, '0')}`,
    'hud:cinematic branch',
  ];

  return (
    <div
      className={`operator-hud-overlay operator-hud-overlay--${state}${reducedMotion ? ' is-reduced-motion' : ''}`}
      data-state={state}
      aria-hidden="true"
    >
      <div className="operator-hud-overlay__grid" />
      <div className="operator-hud-overlay__noise" />
      <div className="operator-hud-scan-beam" />
      <div className="operator-hud-beam operator-hud-beam--top" />
      <div className="operator-hud-beam operator-hud-beam--bottom" />
      <HudReticleGlyph className="operator-hud-reticle operator-hud-reticle--left" size={96} />
      <HudReticleGlyph className="operator-hud-reticle operator-hud-reticle--right" size={96} />
      <div className="operator-hud-telemetry">
        <span className="operator-hud-telemetry__eyebrow">operator mesh</span>
        <div className="operator-hud-telemetry__values">
          <span><strong>{pendingCount}</strong> pending</span>
          <span><strong>{inFlightCount}</strong> transit</span>
          <span><strong>{failedCount}</strong> alerts</span>
        </div>
      </div>
      <HudTelemetryMarquee className="operator-hud-marquee" segments={marquee} />
    </div>
  );
}
