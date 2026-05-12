import { OperatorLogoMark } from '../OperatorLogoMark';
import { HudFrameCorners, HudReticleGlyph, HudRingGlyph } from './HudPrimitives';

type OperatorReactorState = 'idle' | 'scanning' | 'thinking' | 'acting' | 'paused' | 'awaiting-input';

type OperatorReactorCoreProps = {
  state: OperatorReactorState;
  reducedMotion?: boolean;
};

const STATE_COPY: Record<OperatorReactorState, string> = {
  idle: 'standby',
  scanning: 'scan lock',
  thinking: 'synthesis',
  acting: 'dispatch',
  paused: 'suspend',
  'awaiting-input': 'awaiting user',
};

export function OperatorReactorCore({ state, reducedMotion = false }: OperatorReactorCoreProps) {
  const label = STATE_COPY[state];

  return (
    <div
      className={`operator-reactor-shell operator-reactor-shell--${state}${reducedMotion ? ' is-reduced-motion' : ''}`}
      data-state={state}
      aria-hidden="true"
    >
      <span className="operator-reactor-shell__backplate" />
      <span className="operator-reactor-shell__glow" />
      <div className="operator-reactor-shell__rings">
        <HudRingGlyph className="operator-hud-ring operator-hud-ring--outer" spokes={16} radius={49} innerRadius={26} />
        <HudRingGlyph className="operator-hud-ring operator-hud-ring--mid" spokes={12} radius={39} innerRadius={20} withCrosshair />
        <HudRingGlyph className="operator-hud-ring operator-hud-ring--inner" spokes={8} radius={28} innerRadius={10} />
      </div>
      <div className="operator-reactor-core">
        <span className="operator-reactor-core__pulse" />
        <span className="operator-reactor-core__orb" />
        <span className="operator-reactor-core__flare" />
        <OperatorLogoMark variant="compact" className="operator-reactor-core__logo" />
      </div>
      <HudReticleGlyph className="operator-reactor-reticle" size={112} />
      <HudFrameCorners className="operator-reactor-frame" />
      <div className="operator-reactor-readout">
        <span>{label}</span>
      </div>
    </div>
  );
}
