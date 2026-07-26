/**
 * DocsTab — owner controls for the DOCUMENTATION agents (doc regeneration,
 * knowledge-pack delivery/hygiene, and any doc-sweep loops).
 *
 * Sits beside Blender in the left rail (owner ask 2026-07-25).
 *
 * The pane lists FOUR things as of 2026-07-25, after the owner asked "what about
 * the routine that checks for drifted documentation?" and was right that it was
 * missing: the two knowledge-pack routines, plus the doc drift pipeline, which
 * lives in neither the routines table nor a timer — it fires after each git-sync
 * (see SYNC_TRIGGERED_SWEEPS in lib/schedule-inventory.ts). The pipeline shows as
 * two rows on purpose: DETECTION is free and always on, while the doc-steward
 * REPAIR spawns an LLM agent per drift batch and is currently OFF behind the
 * owner-authority flag `papercusp-doc-steward`. Both are listed but not pausable
 * from here — `routines:set` only writes the routines table.
 */
import { FileText } from 'lucide-react';
import { DOCS_PANE_CATEGORIES } from '@papercusp/operator-core/lib/automation/pane-categories';
import AutomationPane from './AutomationPane';

export default function DocsTab({ active }: { active: boolean }) {
  return (
    <AutomationPane
      active={active}
      categories={DOCS_PANE_CATEGORIES}
      title="Docs"
      subtitle="Writes and refreshes docs"
      icon={FileText}
      blurb="Documentation agents — doc regeneration, knowledge-pack delivery and hygiene. Anything marked “tokens” spends money every time it fires."
    />
  );
}
