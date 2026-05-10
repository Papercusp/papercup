'use client';

import { useMemo, useState } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown } from 'lucide-react';

interface EnabledInDropdownProps {
  harnesses: string[];
  className?: string;
}

export default function EnabledInDropdown({ harnesses, className = '' }: EnabledInDropdownProps) {
  const [open, setOpen] = useState(false);
  const sortedHarnesses = useMemo(
    () => Array.from(new Set(harnesses)).sort((a, b) => a.localeCompare(b)),
    [harnesses],
  );

  if (sortedHarnesses.length === 0) return null;

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={`pc-enabled-in-dropdown ${className}`.trim()}
      data-state={open ? 'open' : 'closed'}
    >
      <Collapsible.Trigger asChild>
        <button
          type="button"
          className="pc-enabled-in-trigger"
          aria-label={`Show ${sortedHarnesses.length} enabled harness${sortedHarnesses.length === 1 ? '' : 'es'}`}
        >
          <span>Enabled in</span>
          <strong>{sortedHarnesses.length}</strong>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </Collapsible.Trigger>
      <Collapsible.Content className="pc-enabled-in-content">
        <ul className="pc-enabled-in-list" aria-label="Enabled harnesses">
          {sortedHarnesses.map((harness) => (
            <li key={harness}>
              <code>{harness}</code>
            </li>
          ))}
        </ul>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
