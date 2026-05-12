import { OperatorLogoMark } from '../OperatorLogoMark';
import { HudReticleGlyph } from './HudPrimitives';

type OperatorOverlayState = 'idle' | 'scanning' | 'thinking' | 'acting' | 'paused' | 'awaiting-input';

type OperatorScanOverlayProps = {
  state: OperatorOverlayState;
  reducedMotion?: boolean;
};


export function OperatorScanOverlay({
  state,
  reducedMotion = false,
}: OperatorScanOverlayProps) {

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
      <div className="operator-hud-overlay__badge">
        <OperatorLogoMark variant="compact" className="operator-hud-overlay__logo" />
      </div>
    </div>
  );
}
