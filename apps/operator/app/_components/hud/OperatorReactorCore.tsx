import { HudFrameCorners, HudReticleGlyph, HudRingGlyph } from './HudPrimitives';

type OperatorReactorState = 'idle' | 'scanning' | 'thinking' | 'acting' | 'paused' | 'awaiting-input';

type OperatorReactorCoreProps = {
  state: OperatorReactorState;
  reducedMotion?: boolean;
};

const STATE_COPY: Record<OperatorReactorState, { label: string; code: string }> = {
  idle: { label: 'standby', code: 'O-00' },
  scanning: { label: 'scan lock', code: 'O-14' },
  thinking: { label: 'synthesis', code: 'O-27' },
  acting: { label: 'dispatch', code: 'O-39' },
  paused: { label: 'suspend', code: 'O-41' },
  'awaiting-input': { label: 'awaiting user', code: 'O-52' },
};

export function OperatorReactorCore({ state, reducedMotion = false }: OperatorReactorCoreProps) {
  const copy = STATE_COPY[state];

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
      </div>
      <HudReticleGlyph className="operator-reactor-reticle" size={112} />
      <HudFrameCorners className="operator-reactor-frame" />
      <div className="operator-reactor-readout">
        <span>{copy.label}</span>
        <strong>{copy.code}</strong>
      </div>
    </div>
  );
}
