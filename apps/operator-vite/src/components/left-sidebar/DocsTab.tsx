/**
 * DocsTab — owner controls for the DOCUMENTATION agents (doc regeneration,
 * knowledge-pack delivery/hygiene, and any doc-sweep loops).
 *
 * Sits beside Blender in the left rail (owner ask 2026-07-25). Note that as of
 * 2026-07-25 no documentation routine is ACTIVE — the doc sweeps found in the
 * routines table are agent-armed `loop-su-*` continuation loops, all inactive.
 * The pane still exists so that when one IS armed it is visible and pausable
 * here rather than discovered later from a usage bill.
 */
import { FileText } from 'lucide-react';
import AutomationPane from './AutomationPane';

export default function DocsTab({ active }: { active: boolean }) {
  return (
    <AutomationPane
      active={active}
      categories={['docs']}
      title="Docs"
      subtitle="Writes and refreshes docs"
      icon={FileText}
      blurb="Documentation agents — doc regeneration, knowledge-pack delivery and hygiene. Anything marked “tokens” spends money every time it fires."
    />
  );
}
