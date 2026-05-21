'use client';

/**
 * PlanActions — read-mode chrome strip for the structured-write verbs
 * (P-204, D-004 reconciled).
 *
 * Three buttons + three modal composers, all calling the assisted-
 * write tools through the typed client API:
 *
 *   Set Now      → plans:set-now    { state, next }
 *   +Decision    → plans:add-decision { title, body, refs? }
 *   +Item        → plans:add-item   { phase, text, blockedBy? }
 *
 * On success: invokes onChanged() so PlanDetail can refresh() the
 * underlying usePlan() — which round-trips the new markdown through
 * PlanEditor's setValue. On a domain error (ok: false from the verb)
 * the dialog stays open and shows the error. On a transport error,
 * same — Modal stays open, error rendered, user can retry.
 *
 * The vditor-toolbar variant (D-004 edit-mode surface) will reuse
 * these same dialog components from PLAN_TOOLBAR.click handlers
 * (P-202+).
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/app/harness/Modal';
import {
  addPlanDecision,
  addPlanItem,
  setPlanNow,
  type PlanDecision,
  type PlanItem,
  type WriteResult,
} from './plans-api';

interface Props {
  slug: string;
  /** Existing items — used to pre-populate phase choices and ref typeahead. */
  items: PlanItem[] | undefined;
  decisions: PlanDecision[] | undefined;
  currentNow: { state: string | null; next: string | null } | null | undefined;
  /** Fired after a successful write so the caller can refresh plan data. */
  onChanged: () => void;
  /** Disabled while the file is locked or in raw-Edit mode. */
  disabled?: boolean;
  disabledReason?: string;
}

type Dialog = null | 'set-now' | 'add-decision' | 'add-item';

export default function PlanActions({
  slug,
  items,
  decisions,
  currentNow,
  onChanged,
  disabled,
  disabledReason,
}: Props) {
  const [open, setOpen] = useState<Dialog>(null);

  const phases = useMemo(() => {
    const seen = new Set<string>();
    for (const it of items ?? []) {
      if (it.phase) seen.add(it.phase);
    }
    return Array.from(seen);
  }, [items]);

  const knownItemIds = useMemo(() => (items ?? []).map((i) => i.id), [items]);

  return (
    <div className="pc-plan-actions">
      <button
        type="button"
        className="pc-plan-actions__btn"
        onClick={() => setOpen('set-now')}
        disabled={disabled}
        title={disabled ? disabledReason : 'Replace the ## Now block'}
      >
        Set Now
      </button>
      <button
        type="button"
        className="pc-plan-actions__btn"
        onClick={() => setOpen('add-decision')}
        disabled={disabled}
        title={disabled ? disabledReason : 'Append a new D-NNN decision'}
      >
        + Decision
      </button>
      <button
        type="button"
        className="pc-plan-actions__btn"
        onClick={() => setOpen('add-item')}
        disabled={disabled}
        title={disabled ? disabledReason : 'Append a new P-NNN item'}
      >
        + Item
      </button>

      <SetNowDialog
        open={open === 'set-now'}
        onClose={() => setOpen(null)}
        slug={slug}
        initialState={currentNow?.state ?? ''}
        initialNext={currentNow?.next ?? ''}
        onSuccess={() => {
          setOpen(null);
          onChanged();
        }}
      />
      <AddDecisionDialog
        open={open === 'add-decision'}
        onClose={() => setOpen(null)}
        slug={slug}
        knownItemIds={knownItemIds}
        nextDecisionPreview={previewNextDecisionId(decisions)}
        onSuccess={() => {
          setOpen(null);
          onChanged();
        }}
      />
      <AddItemDialog
        open={open === 'add-item'}
        onClose={() => setOpen(null)}
        slug={slug}
        phases={phases}
        knownItemIds={knownItemIds}
        nextItemPreview={previewNextItemId(items)}
        onSuccess={() => {
          setOpen(null);
          onChanged();
        }}
      />
    </div>
  );
}

function previewNextDecisionId(decisions: PlanDecision[] | undefined): string {
  let max = 0;
  for (const d of decisions ?? []) {
    const n = Number((d.id.match(/D-(\d{3,})$/) ?? [])[1] ?? 0);
    if (n > max) max = n;
  }
  return `D-${String(max + 1).padStart(3, '0')}`;
}

function previewNextItemId(items: PlanItem[] | undefined): string {
  let max = 0;
  for (const it of items ?? []) {
    const n = Number((it.id.match(/P-(\d{3,})$/) ?? [])[1] ?? 0);
    if (n > max) max = n;
  }
  return `P-${String(max + 1).padStart(3, '0')}`;
}

/* ── Set Now dialog ────────────────────────────────────────────────── */

function SetNowDialog({
  open,
  onClose,
  slug,
  initialState,
  initialNext,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  initialState: string;
  initialNext: string;
  onSuccess: () => void;
}) {
  const [state, setState] = useState(initialState);
  const [next, setNext] = useState(initialNext);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset fields when the dialog re-opens after a refresh.
  useResetOnOpen(open, () => {
    setState(initialState);
    setNext(initialNext);
    setError(null);
  });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await setPlanNow({ slug, state: state.trim(), next: next.trim() });
      const err = writeError(r);
      if (err) setError(err);
      else onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Set Now"
      srOnlyTitle
      contentClassName="pc-plan-dialog"
    >
      <form onSubmit={onSubmit} className="pc-plan-dialog__form">
        <header className="pc-plan-dialog__head">
          <h3>Set Now</h3>
          <p>Replace the plan's <code>## Now</code> block — the cold-resume anchor.</p>
        </header>
        <label className="pc-plan-dialog__field">
          <span>State</span>
          <textarea
            value={state}
            onChange={(e) => setState(e.target.value)}
            placeholder="One paragraph: where the plan currently stands."
            rows={3}
            maxLength={2000}
            required
            autoFocus
          />
        </label>
        <label className="pc-plan-dialog__field">
          <span>Next</span>
          <textarea
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="One sentence: the single next concrete action and who should do it."
            rows={2}
            maxLength={800}
            required
          />
        </label>
        <DialogFooter
          error={error}
          submitting={submitting}
          submitLabel="Replace Now"
          onCancel={onClose}
          canSubmit={!!state.trim() && !!next.trim()}
        />
      </form>
    </Modal>
  );
}

/* ── Add Decision dialog ───────────────────────────────────────────── */

function AddDecisionDialog({
  open,
  onClose,
  slug,
  knownItemIds,
  nextDecisionPreview,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  knownItemIds: string[];
  nextDecisionPreview: string;
  onSuccess: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [refsRaw, setRefsRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useResetOnOpen(open, () => {
    setTitle('');
    setBody('');
    setRefsRaw('');
    setError(null);
  });

  const parsedRefs = useMemo(() => parseRefList(refsRaw), [refsRaw]);
  const unknownRefs = parsedRefs.filter((r) => !knownItemIds.includes(r));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await addPlanDecision({
        slug,
        title: title.trim(),
        body: body.trim(),
        refs: parsedRefs.length ? parsedRefs : undefined,
      });
      const err = writeError(r);
      if (err) setError(err);
      else onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add decision"
      srOnlyTitle
      contentClassName="pc-plan-dialog"
    >
      <form onSubmit={onSubmit} className="pc-plan-dialog__form">
        <header className="pc-plan-dialog__head">
          <h3>+ Decision</h3>
          <p>
            Append <code>{nextDecisionPreview}</code> to the <code>## Decisions</code> log.
          </p>
        </header>
        <label className="pc-plan-dialog__field">
          <span>Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short imperative — e.g. UI goes through plans:* only"
            maxLength={200}
            required
            autoFocus
          />
        </label>
        <label className="pc-plan-dialog__field">
          <span>Body</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Paragraph or two. Reference items by P-NNN; they become links."
            rows={6}
            maxLength={5000}
            required
          />
        </label>
        <label className="pc-plan-dialog__field">
          <span>Item refs <em className="pc-plan-dialog__opt">(optional)</em></span>
          <input
            type="text"
            value={refsRaw}
            onChange={(e) => setRefsRaw(e.target.value)}
            placeholder="P-001, P-007 — items this decision relates to"
          />
          {unknownRefs.length ? (
            <span className="pc-plan-dialog__hint pc-plan-dialog__hint--warn">
              Unknown item IDs: {unknownRefs.join(', ')}
            </span>
          ) : null}
        </label>
        <DialogFooter
          error={error}
          submitting={submitting}
          submitLabel="Append decision"
          onCancel={onClose}
          canSubmit={!!title.trim() && !!body.trim()}
        />
      </form>
    </Modal>
  );
}

/* ── Add Item dialog ───────────────────────────────────────────────── */

function AddItemDialog({
  open,
  onClose,
  slug,
  phases,
  knownItemIds,
  nextItemPreview,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  phases: string[];
  knownItemIds: string[];
  nextItemPreview: string;
  onSuccess: () => void;
}) {
  const [phase, setPhase] = useState(phases[0] ?? '');
  const [text, setText] = useState('');
  const [blockedByRaw, setBlockedByRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useResetOnOpen(open, () => {
    setPhase(phases[0] ?? '');
    setText('');
    setBlockedByRaw('');
    setError(null);
  });

  const parsedBlockedBy = useMemo(() => parseRefList(blockedByRaw), [blockedByRaw]);
  const unknownBlockers = parsedBlockedBy.filter((r) => !knownItemIds.includes(r));

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phase.trim()) {
      setError('Phase is required — pick one or type a new heading.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await addPlanItem({
        slug,
        phase: phase.trim(),
        text: text.trim(),
        blockedBy: parsedBlockedBy.length ? parsedBlockedBy : undefined,
      });
      const err = writeError(r);
      if (err) setError(err);
      else onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add item"
      srOnlyTitle
      contentClassName="pc-plan-dialog"
    >
      <form onSubmit={onSubmit} className="pc-plan-dialog__form">
        <header className="pc-plan-dialog__head">
          <h3>+ Item</h3>
          <p>
            Append <code>{nextItemPreview}</code> under a phase. A new phase
            heading is created if you type one that doesn't exist.
          </p>
        </header>
        <label className="pc-plan-dialog__field">
          <span>Phase</span>
          <input
            type="text"
            list="pc-plan-phases"
            value={phase}
            onChange={(e) => setPhase(e.target.value)}
            placeholder='e.g. "Phase 1 — Tooling"'
            required
            autoFocus
          />
          <datalist id="pc-plan-phases">
            {phases.map((p) => <option key={p} value={p} />)}
          </datalist>
        </label>
        <label className="pc-plan-dialog__field">
          <span>Text</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What does this item do? One short sentence is best."
            rows={3}
            maxLength={800}
            required
          />
        </label>
        <label className="pc-plan-dialog__field">
          <span>Blocked by <em className="pc-plan-dialog__opt">(optional)</em></span>
          <input
            type="text"
            value={blockedByRaw}
            onChange={(e) => setBlockedByRaw(e.target.value)}
            placeholder="P-001, P-007 — items this one must wait on"
          />
          {unknownBlockers.length ? (
            <span className="pc-plan-dialog__hint pc-plan-dialog__hint--warn">
              Unknown item IDs: {unknownBlockers.join(', ')}
            </span>
          ) : null}
        </label>
        <DialogFooter
          error={error}
          submitting={submitting}
          submitLabel="Append item"
          onCancel={onClose}
          canSubmit={!!phase.trim() && !!text.trim()}
        />
      </form>
    </Modal>
  );
}

/* ── Footer + helpers ──────────────────────────────────────────────── */

function DialogFooter({
  error,
  submitting,
  submitLabel,
  onCancel,
  canSubmit,
}: {
  error: string | null;
  submitting: boolean;
  submitLabel: string;
  onCancel: () => void;
  canSubmit: boolean;
}) {
  return (
    <footer className="pc-plan-dialog__foot">
      {error ? <p className="pc-plan-dialog__error">{error}</p> : null}
      <div className="pc-plan-dialog__buttons">
        <button
          type="button"
          className="pc-plan-dialog__btn"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="pc-plan-dialog__btn pc-plan-dialog__btn--primary"
          disabled={submitting || !canSubmit}
        >
          {submitting ? 'Submitting…' : submitLabel}
        </button>
      </div>
    </footer>
  );
}

function writeError(r: WriteResult<unknown>): string | null {
  if (!r || typeof r !== 'object') return 'unexpected response shape';
  const o = r as Record<string, unknown>;
  if (o.ok === true) return null;
  if (typeof o.error === 'string') {
    // The lock-conflict path carries the holder's identity — surface
    // it inline so the user knows who/what to wait for.
    if (o.error === 'busy' && Array.isArray(o.busy) && o.busy.length > 0) {
      const b = o.busy[0] as { owner_label?: string; intent?: string };
      const who = b.owner_label ?? 'another agent';
      return b.intent ? `busy: held by ${who} (${b.intent})` : `busy: held by ${who}`;
    }
    return o.error;
  }
  return 'unexpected response shape';
}

function parseRefList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^[PD]-\d{3,}$/.test(s));
}

/** Fire `reset()` every time `open` transitions false → true. */
function useResetOnOpen(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
