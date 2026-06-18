'use client';

import * as RS from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * Group wrapper around a sub-list of `SelectOption`s. Mix freely with
 * flat `SelectOption`s in the same `options` array — the wrapper
 * decides which are which by the discriminant `kind` field. Added per
 * `plans-newbutton-and-subharness-scope-2026-05-25` P-026 so the
 * /adv/sessions "Start from plan context" picker can group plans by
 * their resolved harness.
 */
export interface SelectGroup {
  kind: 'group';
  /** Group heading, e.g. the harness slug. */
  label: ReactNode;
  options: SelectOption[];
}

export type SelectEntry = SelectOption | SelectGroup;

const GROUP_LABEL_STYLE: CSSProperties = {
  padding: '6px 8px 2px',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'color-mix(in oklab, var(--fg, #e7f7ff), transparent 38%)',
};

function isGroup(entry: SelectEntry): entry is SelectGroup {
  return (entry as { kind?: string }).kind === 'group';
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
  background: 'color-mix(in srgb, var(--bg-deeper), transparent 2%)',
  color: 'var(--fg)',
  border: '1px solid color-mix(in oklab, var(--accent), transparent 62%)',
  borderRadius: 10,
  padding: 6,
  zIndex: 70,
  boxShadow: '0 18px 54px rgba(0,0,0,0.62), inset 0 1px 0 rgba(255,255,255,0.06)',
  fontSize: 12,
  minWidth: 'var(--radix-select-trigger-width)',
  backdropFilter: 'blur(14px) saturate(150%)',
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
  id,
  ariaLabel,
  disabled,
  testId,
  triggerStyle,
  contentStyle,
  className,
  triggerClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectEntry[];
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  testId?: string;
  triggerStyle?: CSSProperties;
  contentStyle?: CSSProperties;
  className?: string;
  triggerClassName?: string;
}) {
  return (
    <RS.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RS.Trigger
        id={id}
        aria-label={ariaLabel}
        data-testid={testId}
        className={triggerClassName ?? className}
        style={triggerClassName || className ? undefined : { ...TRIGGER_DEFAULT_STYLE, ...triggerStyle }}
      >
        <RS.Value placeholder={placeholder} />
        <RS.Icon><ChevronDown size={11} /></RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          data-anim="pop"
          position="popper"
          sideOffset={4}
          style={{ ...CONTENT_STYLE, ...contentStyle }}
        >
          <RS.Viewport>
            {/* Radix throws ("must have a value prop that is not an empty
                string") if any Item value is '', taking the whole subtree
                down with it. Drop empty-value options defensively so a bad
                caller can't crash the page — an empty value isn't selectable
                anyway (the empty string is reserved for "no selection"). */}
            {options.map((entry, idx) =>
              isGroup(entry) ? (
                <RS.Group key={`grp-${idx}`}>
                  <RS.Label style={GROUP_LABEL_STYLE}>{entry.label}</RS.Label>
                  {entry.options.filter((opt) => opt.value !== '').map((opt) => (
                    <RS.Item key={opt.value} value={opt.value} disabled={opt.disabled} style={ITEM_STYLE} className="h-select-item">
                      <RS.ItemText>{opt.label}</RS.ItemText>
                      <RS.ItemIndicator><Check size={11} /></RS.ItemIndicator>
                    </RS.Item>
                  ))}
                </RS.Group>
              ) : entry.value === '' ? null : (
                <RS.Item key={entry.value} value={entry.value} disabled={entry.disabled} style={ITEM_STYLE} className="h-select-item">
                  <RS.ItemText>{entry.label}</RS.ItemText>
                  <RS.ItemIndicator><Check size={11} /></RS.ItemIndicator>
                </RS.Item>
              ),
            )}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
