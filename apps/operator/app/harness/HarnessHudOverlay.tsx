import { memo } from 'react';
import { HudFrameCorners, HudReticleGlyph, HudRingGlyph, HudTelemetryMarquee } from '../_components/hud/HudPrimitives';

type HarnessHudOverlayProps = {
  alive: boolean;
  activePanel: string;
  laneCount: number;
  pendingCount: number;
  escalated: boolean;
};

function HarnessHudOverlayInner({
  alive,
  activePanel,
  laneCount,
  pendingCount,
  escalated,
}: HarnessHudOverlayProps) {
  const marquee = [
    alive ? 'mission:live' : 'mission:idle',
    `panel:${activePanel}`,
    `lanes:${laneCount}`,
    `pending:${pendingCount}`,
    escalated ? 'escalation:armed' : 'escalation:clear',
  ];

  return (
    <div className={`h-hud-overlay${alive ? ' is-live' : ''}`} data-panel={activePanel} aria-hidden="true">
      <div className="h-hud-overlay__grid" />
      <div className="h-hud-overlay__scanline" />
      <div className="h-hud-overlay__wash" />

      <div className="h-hud-node h-hud-node--right">
        <HudReticleGlyph className="h-hud-node__reticle" size={88} />
        <span>pending</span>
        <strong>{pendingCount}</strong>
      </div>

      <div className="h-hud-dial">
        <HudRingGlyph className="h-hud-dial-ring h-hud-dial-ring--outer" spokes={14} radius={52} innerRadius={24} withCrosshair />
        <HudRingGlyph className="h-hud-dial-ring h-hud-dial-ring--inner" spokes={8} radius={34} innerRadius={12} />
        <HudFrameCorners className="h-hud-dial-frame" />
        <div className="h-hud-dial-copy">
          <span>{alive ? 'reactor live' : 'reactor idle'}</span>
          <strong>{activePanel}</strong>
        </div>
      </div>

      <HudTelemetryMarquee className="h-hud-marquee" segments={marquee} />
    </div>
  );
}

// All 5 props are primitives — default shallow compare is sufficient. Without
// this memo, the HUD overlay re-renders on every HarnessDashboard render
// (~22/sec at idle, per long-task profiling), which churns the marquee child
// list and registers ~600 DOM mutations per 8-second idle window.
export default memo(HarnessHudOverlayInner);
