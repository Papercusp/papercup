'use client';

import * as RS from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

const TRIGGER_DEFAULT_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  background: 'var(--bg-2)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  fontSize: 12,
  fontFamily: 'inherit',
  cursor: 'pointer',
  outline: 'none',
};

const CONTENT_STYLE: CSSProperties = {
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: 4,
  zIndex: 70,
  boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
  fontSize: 12,
  minWidth: 'var(--radix-select-trigger-width)',
};

const ITEM_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '4px 8px',
  borderRadius: 3,
  outline: 'none',
  cursor: 'pointer',
};

/**
 * Select — Radix Select wrapper that mirrors the visual of the harness's
 * native <select> elements (dark theme, terse). Replaces:
 *   <select value={x} onChange={(e) => setX(e.target.value)}>
 *     <option value="a">A</option>
 *   </select>
 *
 * with:
 *   <Select value={x} onChange={setX} options={[{value:'a', label:'A'}]} />
 *
 * Trigger and Content can be restyled via `triggerStyle` / `contentStyle`,
 * or passed `className` for full CSS override.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  disabled,
  triggerStyle,
  contentStyle,
  className,
  triggerClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  triggerStyle?: CSSProperties;
  contentStyle?: CSSProperties;
  className?: string;
  triggerClassName?: string;
}) {
  return (
    <RS.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RS.Trigger
        aria-label={ariaLabel}
        className={triggerClassName ?? className}
        style={triggerClassName || className ? undefined : { ...TRIGGER_DEFAULT_STYLE, ...triggerStyle }}
      >
        <RS.Value placeholder={placeholder} />
        <RS.Icon><ChevronDown size={11} /></RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          position="popper"
          sideOffset={4}
          style={{ ...CONTENT_STYLE, ...contentStyle }}
        >
          <RS.Viewport>
            {options.map((opt) => (
              <RS.Item key={opt.value} value={opt.value} disabled={opt.disabled} style={ITEM_STYLE} className="h-select-item">
                <RS.ItemText>{opt.label}</RS.ItemText>
                <RS.ItemIndicator><Check size={11} /></RS.ItemIndicator>
              </RS.Item>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
