/**
 * SidebarHarnessSelector — wraps HarnessSelectorChip with a fetched
 * harness list. Drops into the OperatorChatSidebar header sub-row.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.4
 */

'use client';

import { useEffect, useState } from 'react';
import { HarnessSelectorChip, type HarnessOption } from './HarnessSelectorChip';

interface Project {
  slug: string;
  path?: string;
  harness_kind?: string;
}

export function SidebarHarnessSelector({ className }: { className?: string }) {
  const [options, setOptions] = useState<HarnessOption[] | null>(null);

  useEffect(() => {
    let cancel = false;
    // /lite is the fast (no-PG) path — 91 projects in <50ms vs ~4s.
    fetch('/api/harness/projects/lite')
      .then((r) => (r.ok ? r.json() : { projects: [] }))
      .then((j: { projects: Project[] }) => {
        if (cancel) return;
        // Filter to coding-flavor harnesses and sort alphabetically;
        // department/org sub-harnesses are 80% of the 91-row noise.
        const coding = (j.projects ?? [])
          .filter((p) => !p.harness_kind || p.harness_kind === 'coding')
          .map((p) => ({ slug: p.slug, label: p.slug }))
          .sort((a, b) => a.label.localeCompare(b.label));
        setOptions(coding);
      })
      .catch(() => {
        if (!cancel) setOptions([]);
      });
    return () => {
      cancel = true;
    };
  }, []);

  if (options === null || options.length === 0) return null;
  return (
    <div className={className}>
      <span className="op-chat-header-row-label">Harness</span>
      <HarnessSelectorChip options={options} className="op-chat-harness-select" />
    </div>
  );
}
