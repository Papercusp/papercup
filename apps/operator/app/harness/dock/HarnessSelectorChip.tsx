/**
 * HarnessSelectorChip — moved-from-header harness picker, lives in the
 * OperatorChatSidebar's new sub-row.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §3.4
 *
 * Drives:
 *   - `?focusSlug=` (nuqs) — default slug for newly-opened panels
 *   - agent context default ("show me X" without explicit harness)
 *
 * Does NOT retroactively change open panels — that's the point of the
 * §3.4 unbundling. Each panel carries its own `params.harnessSlug`.
 */

'use client';

import { useEffect } from 'react';
import { useQueryState, parseAsString } from 'nuqs';
import { Select } from '../Select';

export interface HarnessOption {
  slug: string;
  label: string;
}

interface HarnessSelectorChipProps {
  options: HarnessOption[];
  className?: string;
}

export function HarnessSelectorChip({ options, className }: HarnessSelectorChipProps) {
  const [focusSlug, setFocusSlug] = useQueryState(
    'focusSlug',
    parseAsString.withDefault(''),
  );

  // Best-effort: if no focusSlug set, pick the first option.
  useEffect(() => {
    if (!focusSlug && options.length > 0) {
      void setFocusSlug(options[0].slug);
    }
  }, [focusSlug, options, setFocusSlug]);

  const active = options.find((o) => o.slug === focusSlug) ?? options[0];

  return (
    <Select
      value={active?.slug ?? ''}
      onChange={(value) => {
        void setFocusSlug(value);
      }}
      options={options.map((o) => ({ value: o.slug, label: o.label }))}
      ariaLabel="Switch active harness"
      triggerClassName={className}
    />
  );
}
