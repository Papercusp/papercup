'use client';

/**
 * Combobox — a SEARCHABLE single-select. Focus/click shows the full list
 * before you type anything; typing filters it.
 *
 * Built for `hud-session-launcher-and-board-tabs-2026-07-26` P-003 (owner ask
 * 2026-07-26: "make the select plan and model selector search boxes that show
 * the full list if you focus it before typing into it and then filters as you
 * type"), and deliberately generic so P-004 (plan filter) and P-008 (effort
 * selector) reuse it instead of growing two more bespoke pickers (D-002).
 *
 * WHY NOT `Select`: `harness/Select` is a Radix Select, which has no search
 * affordance and cannot be given one — its listbox owns keyboard input for
 * type-ahead jumping. It stays the right control for short static option
 * lists; this is the control for long ones.
 *
 * COMPOSITION — both halves are existing primitives, nothing hand-rolled:
 *   - `harness/Popover` (Radix Popover) anchors + portals the panel, and
 *     handles outside-click, Escape, and focus restore to the trigger.
 *     Portalling is load-bearing: the launcher sits inside horizontally
 *     scrolling HUD chrome, so an in-flow absolutely-positioned panel would
 *     be clipped by an ancestor's overflow.
 *   - `cmdk` (already a dependency, already used by CommandPalette) owns
 *     filtering, scoring and arrow-key navigation.
 *
 * P-006 (dropdown overflow cut off with no scrollbar) and P-007 (rich
 * two-line rows carrying a full timestamp) are properties of this component
 * rather than separate work: the list is its own bounded scroll container
 * (`--radix-popover-content-available-height` clamps it to the space actually
 * below the trigger), and `ComboboxOption.detail` renders a second line.
 */
import { Command as CmdK } from 'cmdk';
import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Popover } from './Popover';

export interface ComboboxOption {
  value: string;
  /**
   * Primary line. Plain text (not ReactNode) because it doubles as the
   * closed trigger's label and as the text cmdk scores the search against.
   */
  label: string;
  /** Optional second line under the label — e.g. a full updated timestamp. */
  detail?: ReactNode;
  /** Extra text folded into the search index but never rendered. */
  keywords?: string[];
  disabled?: boolean;
}

export interface ComboboxGroup {
  kind: 'group';
  /** Group heading, e.g. a harness slug. */
  label: string;
  options: ComboboxOption[];
}

export type ComboboxEntry = ComboboxOption | ComboboxGroup;

export function isComboboxGroup(entry: ComboboxEntry): entry is ComboboxGroup {
  return (entry as { kind?: string }).kind === 'group';
}

/** Flatten groups away — exported for callers that need the selected option. */
export function flattenComboboxEntries(entries: ComboboxEntry[]): ComboboxOption[] {
  const out: ComboboxOption[] = [];
  for (const entry of entries) {
    if (isComboboxGroup(entry)) out.push(...entry.options);
    else out.push(entry);
  }
  return out;
}

export interface ComboboxProps {
  /** Selected option value, or null when nothing is chosen. */
  value: string | null;
  onChange: (value: string) => void;
  options: ComboboxEntry[];
  /** Required — labels the trigger AND the popover for screen readers. */
  ariaLabel: string;
  /** Trigger text when `value` matches no option. */
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  id?: string;
  testId?: string;
  /** Appended to the trigger's base class — it never replaces the base
   *  styling, so a caller passing only a width can't accidentally strip the
   *  control's appearance (the trap in `Select`'s replace-semantics). */
  triggerClassName?: string;
  /** Hard ceiling for the list in px. The panel also clamps itself to the
   *  space actually available below the trigger, whichever is smaller. */
  maxListHeight?: number;
  align?: 'start' | 'center' | 'end';
}

export function Combobox({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyLabel = 'No matches',
  disabled,
  id,
  testId,
  triggerClassName,
  maxListHeight = 320,
  align = 'start',
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const flat = useMemo(() => flattenComboboxEntries(options), [options]);
  const selected = useMemo(
    () => (value == null ? null : flat.find((o) => o.value === value) ?? null),
    [flat, value],
  );

  // Reset the query on every close so the next open shows the FULL list —
  // the explicit ask in P-003. Without this, reopening would silently
  // restore the previous filter and look like options had gone missing.
  const setOpenAndReset = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  }, []);

  const select = useCallback(
    (optValue: string) => {
      onChange(optValue);
      setOpenAndReset(false);
    },
    [onChange, setOpenAndReset],
  );

  const renderItem = (opt: ComboboxOption) => (
    <CmdK.Item
      key={opt.value}
      // `value` is the option's own value, which is unique by construction —
      // labels are not (two plans can share a title), and duplicate cmdk
      // values collapse into one selectable row. The human-readable text
      // rides along in `keywords`, which cmdk scores equally.
      value={opt.value}
      keywords={[opt.label, ...(opt.keywords ?? [])]}
      disabled={opt.disabled}
      onSelect={() => select(opt.value)}
      className="h-combobox__item"
    >
      <span className="h-combobox__item-copy">
        <span className="h-combobox__item-label">{opt.label}</span>
        {opt.detail != null && <span className="h-combobox__item-detail">{opt.detail}</span>}
      </span>
      {opt.value === value && (
        <Check size={11} className="h-combobox__item-check" aria-hidden="true" />
      )}
    </CmdK.Item>
  );

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={setOpenAndReset}
      side="bottom"
      align={align}
      sideOffset={4}
      ariaLabel={ariaLabel}
      // Focus must land in the search input on open — that IS the feature.
      autoFocusOnOpen
      contentClassName="h-combobox__panel"
      contentStyle={{ ['--h-combobox-max-list' as string]: `${maxListHeight}px` }}
      trigger={
        <button
          type="button"
          id={id}
          data-testid={testId}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          className={`h-combobox__trigger${triggerClassName ? ` ${triggerClassName}` : ''}`}
        >
          <span
            className={`h-combobox__trigger-label${selected ? '' : ' h-combobox__trigger-label--placeholder'}`}
          >
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      }
    >
      {/* cmdk renders `label` as a visually-hidden <label> for its input and
          hardcodes aria-labelledby onto that input AFTER spreading props — so
          an aria-label passed to CmdK.Input is silently overridden and the
          input's accessible name comes from HERE. Naming it "Search <x>"
          rather than "<x>" also keeps it distinct from the trigger button,
          which carries the plain ariaLabel. */}
      <CmdK label={`Search ${ariaLabel}`} loop className="h-combobox__cmd">
        <CmdK.Input
          value={query}
          onValueChange={setQuery}
          placeholder={searchPlaceholder}
          className="h-combobox__input"
        />
        <CmdK.List className="h-combobox__list">
          <CmdK.Empty className="h-combobox__empty">{emptyLabel}</CmdK.Empty>
          {options.map((entry, idx) =>
            isComboboxGroup(entry) ? (
              <CmdK.Group
                key={`grp-${idx}`}
                heading={entry.label}
                className="h-combobox__group"
              >
                {entry.options.map(renderItem)}
              </CmdK.Group>
            ) : (
              renderItem(entry)
            ),
          )}
        </CmdK.List>
      </CmdK>
    </Popover>
  );
}
