'use client';

/**
 * Commit-on-blur number field with range validation, for per-field auto-save
 * settings pages (form-patterns §2 — the numeric sibling of lib/forms
 * DraftInput). Typing stays local; the value persists only on blur/Enter and
 * only when it's a finite number inside [min, max]. An invalid or
 * out-of-range draft gets an inline error and the stored value stays
 * untouched — never clamp-and-save mid-edit (that's how /settings/voice used
 * to persist a PUT per keystroke and fight the user's typing). Escape
 * reverts; external value changes (a peer field's save echoing the whole
 * prefs object) are adopted only while idle.
 */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

const labelStyle: CSSProperties = { display: 'block', fontWeight: 700, fontSize: 12, marginBottom: 4 };

export function NumField({ label, ariaLabel, value, step = 1, min = 0, max, onCommit, hint, inputStyle }: {
  label: ReactNode;
  /** Required when `label` isn't a plain string. */
  ariaLabel?: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onCommit: (n: number) => void;
  hint?: ReactNode;
  inputStyle?: CSSProperties;
}) {
  const [draft, setDraft] = useState(value.toString());
  const [error, setError] = useState<string | null>(null);
  const focusedRef = useRef(false);
  // Adopt external value changes (hydration, another field's save echoing the
  // whole prefs object back) only while idle — never mid-edit.
  useEffect(() => {
    if (!focusedRef.current) { setDraft(value.toString()); setError(null); }
  }, [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || draft.trim() === '') {
      setError('not a number — keeping the saved value');
      return;
    }
    if (n < min || (max != null && n > max)) {
      setError(max != null ? `out of range (${min}–${max}) — keeping the saved value` : `must be ≥ ${min} — keeping the saved value`);
      return;
    }
    setError(null);
    if (n !== value) onCommit(n);
  };
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <input
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        aria-invalid={error ? true : undefined}
        onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
        onFocus={() => { focusedRef.current = true; }}
        onBlur={() => { focusedRef.current = false; commit(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') { setDraft(value.toString()); setError(null); }
        }}
        style={{ padding: '6px 10px', width: '100%', fontSize: 13, ...(error ? { borderColor: 'var(--bad)' } : {}), ...inputStyle }}
      />
      {error && <p role="alert" style={{ marginTop: 4, fontSize: 11, color: 'var(--bad)' }}>{error}</p>}
      {hint && <p style={{ marginTop: 4, fontSize: 11, color: 'var(--fg-mute)' }}>{hint}</p>}
    </div>
  );
}
