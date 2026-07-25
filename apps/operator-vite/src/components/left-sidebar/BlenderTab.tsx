/**
 * BlenderTab — owner controls for the LEARNING agents (the self-improvement loop:
 * blueprint singletons, the gym cycle, the improvement pipeline).
 *
 * Sits next to Kettle in the left rail (owner ask 2026-07-25). These are the
 * routines that were quietly consuming the owner's weekly Claude limit with no
 * surface to see or stop them — the Blender is that surface.
 */
import { Blend } from 'lucide-react';
import AutomationPane from './AutomationPane';

export default function BlenderTab({ active }: { active: boolean }) {
  return (
    <AutomationPane
      active={active}
      categories={['learning']}
      title="Blender"
      subtitle="Learns and self-improves"
      icon={Blend}
      viewParam="blenderView"
      blurb="Learning agents that run on a schedule — blueprint singletons, the gym cycle, and the improvement pipeline. Anything marked “tokens” spends money every time it fires."
      spendRoles={['scout', 'gym', 'worker', 'mug', 'kettle']}
    />
  );
}
