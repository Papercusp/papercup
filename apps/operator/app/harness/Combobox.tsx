'use client';

/**
 * Combobox — a SEARCHABLE single-select whose control IS a text box.
 *
 * The visible control is the search input itself: click or tab into it and the
 * full list drops open; type and it filters. There is no separate "open the
 * panel, then find the search field inside it" step.
 *
 * Built for `hud-session-launcher-and-board-tabs-2026-07-26` P-003 (owner ask
 * 2026-07-26: "make the select plan and model selector search boxes that show
 * the full list if you focus it before typing into it and then filters as you
 * type") and reshaped to input-as-control per the owner's follow-up: "make the
 * search dropdowns show as a text box to type in with the default as just the
 * default text". Deliberately generic so P-004 (plan filter) and P-008 (effort
 * selector) reuse it rather than growing more bespoke pickers (D-002).
 *
 * "Default as just the default text": when the current `value` is `emptyValue`
 * (or matches nothing), the box renders EMPTY with `placeholder` showing — so
 * the default reads as placeholder text, not as a typed-in value.
 *
 * COMPOSITION — both halves are existing primitives, nothing hand-rolled:
 *   - `harness/Popover` anchors + portals the list and handles Escape/dismiss.
 *     It is used in ANCHOR mode (not trigger mode): a Trigger would toggle the
 *     panel shut every time the user clicked their own input to move the
 *     cursor, so open state is driven here from focus/typing/selection, and
 *     `keepOpenWithin` exempts the input from Radix's outside-dismiss.
 *     Portalling is load-bearing: the launcher sits inside horizontally
 *     scrolling HUD chrome, so an in-flow panel would be clipped by an
 *     ancestor's overflow.
 *   - `cmdk` (already a dependency, already used by CommandPalette) owns
 *     filtering, scoring and arrow-key navigation. Its `<Command>` root wraps
 *     BOTH the inline input and the portalled list; that is safe because cmdk
 *     scopes its item DOM queries to the List's own inner ref, not to the
 *     command root, so the list may live in a portal.
 *
 * P-006 (overflow cut off with no scrollbar) and P-007 (rich two-line rows
 * carrying a full timestamp) are properties of this component rather than
 * separate work: the list is its own bounded scroll container (clamped to the
 * room actually below the control), and `ComboboxOption.detail` renders a
 * second line.
 */
import { Command as CmdK } from 'cmdk';
import { Check, ChevronDown } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Popover } from './Popover';

export interface ComboboxOption {
  value: string;
  /**
   * Primary line. Plain text (not ReactNode) because it doubles as what the
   * text box displays when this option is selected, and as the text cmdk
   * scores the search against.
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
  /** Required — labels the text box AND the list for screen readers. */
  ariaLabel: string;
  /**
   * The default text. Shown as the input's PLACEHOLDER whenever no real
   * selection is active, so the default state reads as prompt text rather
   * than as something the user typed.
   */
  placeholder?: string;
  /**
   * The sentinel value meaning "nothing really chosen" (e.g. a
   * `__select_plan__` / `__default_model__` row that exists in the list so the
   * user can get back to it). While `value` equals this, the box shows the
   * placeholder instead of that row's label.
   */
  emptyValue?: string;
  emptyLabel?: string;
  disabled?: boolean;
  id?: string;
  testId?: string;
  /** Appended to the control's base class — never replaces it, so a caller
   *  passing only a width can't strip the control's appearance (the trap in
   *  `Select`'s replace-semantics). */
  triggerClassName?: string;
  /** Hard ceiling for the list in px. The panel also clamps itself to the
   *  space actually available below the control, whichever is smaller. */
  maxListHeight?: number;
  align?: 'start' | 'center' | 'end';
}

export function Combobox({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder = 'Select…',
  emptyValue,
  emptyLabel = 'No matches',
  disabled,
  id,
  testId,
  triggerClassName,
  maxListHeight = 320,
  align = 'start',
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  /**
   * What the user has typed since opening, or null when the box is simply
   * displaying the current selection. The null state is what lets a focus
   * show the FULL list while the box still reads as the chosen option.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const flat = useMemo(() => flattenComboboxEntries(options), [options]);
  const selected = useMemo(() => {
    if (value == null || (emptyValue != null && value === emptyValue)) return null;
    return flat.find((o) => o.value === value) ?? null;
  }, [flat, value, emptyValue]);

  const shown = draft ?? selected?.label ?? '';
  /**
   * Only filter once the user actually types. Otherwise focusing a box that
   * displays "Claude Opus" would filter the list down to Claude Opus — the
   * opposite of the requirement that focus reveals everything.
   */
  const shouldFilter = draft != null && draft.trim() !== '';

  const close = useCallback(() => {
    setOpen(false);
    setDraft(null);
  }, []);

  const select = useCallback(
    (optValue: string) => {
      onChange(optValue);
      setOpen(false);
      setDraft(null);
    },
    [onChange],
  );

  const renderItem = (opt: ComboboxOption) => (
    <CmdK.Item
      key={opt.value}
      // `value` is the option's own value, unique by construction — labels are
      // not (two plans can share a title), and duplicate cmdk values collapse
      // into one selectable row. The human-readable text rides along in
      // `keywords`, which cmdk scores equally.
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
    <CmdK
      label={ariaLabel}
      loop
      shouldFilter={shouldFilter}
      className={`h-combobox${triggerClassName ? ` ${triggerClassName}` : ''}`}
      // cmdk handles ArrowUp/Down/Enter at its root; the inline input sits
      // inside that root, so navigation works even though the list is
      // portalled elsewhere in the DOM.
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        } else if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
          setOpen(true);
        }
      }}
    >
      <Popover
        open={open && !disabled}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        side="bottom"
        align={align}
        sideOffset={4}
        ariaLabel={ariaLabel}
        // Focus must STAY in the text box while the list is open — that is the
        // whole point of the input-as-control shape.
        autoFocusOnOpen={false}
        keepOpenWithin={boxRef}
        contentClassName="h-combobox__panel"
        contentStyle={{ ['--h-combobox-max-list' as string]: `${maxListHeight}px` }}
        anchor={
          <div className="h-combobox__box" ref={boxRef} data-open={open ? 'true' : undefined}>
            <CmdK.Input
              id={id}
              data-testid={testId}
              disabled={disabled}
              value={shown}
              onValueChange={(v) => {
                setDraft(v);
                if (!disabled) setOpen(true);
              }}
              onFocus={(e) => {
                if (disabled) return;
                setDraft(null);
                setOpen(true);
                // Select-all so the first keystroke replaces the shown
                // selection rather than appending to it.
                e.currentTarget.select();
              }}
              onMouseDown={() => {
                if (!disabled) setOpen(true);
              }}
              onBlur={close}
              placeholder={placeholder}
              className="h-combobox__input"
            />
            <ChevronDown size={11} aria-hidden="true" className="h-combobox__chevron" />
          </div>
        }
      >
        <CmdK.List className="h-combobox__list">
          <CmdK.Empty className="h-combobox__empty">{emptyLabel}</CmdK.Empty>
          {options.map((entry, idx) =>
            isComboboxGroup(entry) ? (
              <CmdK.Group key={`grp-${idx}`} heading={entry.label} className="h-combobox__group">
                {entry.options.map(renderItem)}
              </CmdK.Group>
            ) : (
              renderItem(entry)
            ),
          )}
        </CmdK.List>
      </Popover>
    </CmdK>
  );
}
