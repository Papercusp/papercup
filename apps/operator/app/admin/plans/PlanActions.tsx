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
import { toast } from 'sonner';
import { Modal } from '@/app/harness/Modal';
import { launchOmpAgent } from '@/lib/native-omp-launch';
import {
  addPlanDecision,
  addPlanItem,
  setPlanNow,
  promoteToHarness,
  type PlanDecision,
  type PlanItem,
  type PromoteToHarnessResult,
  type WriteResult,
} from './plans-api';

interface Props {
  slug: string;
  /** Existing items — used to pre-populate phase choices and ref typeahead. */
  items: PlanItem[] | undefined;
  decisions: PlanDecision[] | undefined;
  currentNow: { state: string | null; next: string | null } | null | undefined;
  /** Plan title — surfaced into the launched OMP session label so the
   *  /adv/sessions list reads naturally. */
  planTitle?: string | null;
  /** Fired after a successful write so the caller can refresh plan data. */
  onChanged: () => void;
  /** Disabled while the file is locked or in raw-Edit mode. */
  disabled?: boolean;
  disabledReason?: string;
}

type Dialog = null | 'set-now' | 'add-decision' | 'add-item' | 'promote';

export default function PlanActions({
  slug,
  items,
  decisions,
  currentNow,
  planTitle,
  onChanged,
  disabled,
  disabledReason,
}: Props) {
  const [open, setOpen] = useState<Dialog>(null);
  const [launchingAgent, setLaunchingAgent] = useState(false);

  const onLaunchAgent = async () => {
    if (launchingAgent) return;
    setLaunchingAgent(true);
    try {
      const label = planTitle?.trim() || slug;
      const result = await launchOmpAgent({ slug: null, planSlug: slug, label });
      if (result.ok) {
        toast.success(`Launched OMP for ${slug}.`, { duration: 4000 });
      } else if (result.installCmd) {
        toast.error(
          `${result.error ?? 'OMP launch prerequisites are missing.'} Run: ${result.installCmd}`,
          { duration: 12000 },
        );
      } else {
        toast.error(`Launch failed: ${result.error ?? 'unknown error'}`, { duration: 10000 });
      }
    } finally {
      setLaunchingAgent(false);
    }
  };

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
        title={
          disabled
            ? disabledReason
            : 'Log a decision — the rationale behind a choice (rejected alternative, constraint, argument that settled it). Gets a permanent D-NNN id.'
        }
      >
        + Decision
      </button>
      <button
        type="button"
        className="pc-plan-actions__btn"
        onClick={() => setOpen('add-item')}
        disabled={disabled}
        title={
          disabled
            ? disabledReason
            : 'Add a task — one concrete work unit under a phase. Tracked by status (todo / wip / done / …). Gets a permanent P-NNN id.'
        }
      >
        + Task
      </button>
      <button
        type="button"
        className="pc-plan-actions__btn pc-plan-actions__btn--promote"
        onClick={() => setOpen('promote')}
        disabled={disabled || (items ?? []).filter((i) => i.effectiveStatus === 'todo' || i.effectiveStatus === 'wip').length === 0}
        title={
          disabled
            ? disabledReason
            : 'Promote todo/wip plan items to harness features via plans:promote'
        }
      >
        → Harness
      </button>
      <button
        type="button"
        className="pc-plan-actions__btn pc-plan-actions__btn--launch"
        onClick={onLaunchAgent}
        disabled={launchingAgent}
        title={`Launch a power-user OMP agent terminal tagged with ${slug}; appears in /adv/sessions`}
      >
        {launchingAgent ? 'Launching…' : 'Launch agent'}
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
      <PromoteDialog
        open={open === 'promote'}
        onClose={() => setOpen(null)}
        slug={slug}
        items={items}
        onSuccess={(count) => {
          setOpen(null);
          toast.success(`Promoted ${count} feature${count === 1 ? '' : 's'} to harness. Worker will pick up shortly.`, { duration: 6000 });
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
            A <strong>decision</strong> is a rationale-log entry — capture
            why this choice was made and what was rejected. Append{' '}
            <code>{nextDecisionPreview}</code> to the{' '}
            <code>## Decisions</code> log.
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
      title="Add task"
      srOnlyTitle
      contentClassName="pc-plan-dialog"
    >
      <form onSubmit={onSubmit} className="pc-plan-dialog__form">
        <header className="pc-plan-dialog__head">
          <h3>+ Task</h3>
          <p>
            A <strong>task</strong> (also called an <em>item</em> in plan
            markdown) is one concrete work unit under a phase. Append{' '}
            <code>{nextItemPreview}</code>; a new phase heading is created
            if you type one that doesn't exist.
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

/* ── Promote to Harness dialog ─────────────────────────────────────── */

function PromoteDialog({
  open,
  onClose,
  slug,
  items,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  slug: string;
  items: PlanItem[] | undefined;
  onSuccess: (count: number) => void;
}) {
  const [harnessSlug, setHarnessSlug] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PromoteToHarnessResult | null>(null);

  const candidateItems = useMemo(
    () =>
      (items ?? []).filter(
        (i) => i.effectiveStatus === 'todo' || i.effectiveStatus === 'wip',
      ),
    [items],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useResetOnOpen(open, () => {
    setHarnessSlug('');
    setSelected(new Set(candidateItems.map((i) => i.id)));
    setError(null);
    setResult(null);
  });

  // Keep selected in sync when candidateItems changes (e.g. dialog reopened).
  useEffect(() => {
    if (open) {
      setSelected(new Set(candidateItems.map((i) => i.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggleItem = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const hs = harnessSlug.trim();
    if (!hs) {
      setError('Harness slug is required.');
      return;
    }
    const features = candidateItems
      .filter((i) => selected.has(i.id))
      .map((i) => ({ title: i.text, from_items: [i.id] }));
    if (features.length === 0) {
      setError('Select at least one item to promote.');
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const r = await promoteToHarness({ slug, harness_slug: hs, features, apply: true });
      if (!r.ok) {
        setError(r.error ?? 'promote failed');
      } else {
        setResult(r);
      }
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
      title="Promote to harness"
      srOnlyTitle
      contentClassName="pc-plan-dialog"
    >
      {result ? (
        <div className="pc-plan-dialog__form">
          <header className="pc-plan-dialog__head">
            <h3>Promoted</h3>
            <p>
              {result.features_created ?? result.ids?.length ?? 0} feature(s) created in{' '}
              <strong>{harnessSlug}</strong>.
            </p>
          </header>
          <footer className="pc-plan-dialog__foot">
            <div className="pc-plan-dialog__buttons">
              <button
                type="button"
                className="pc-plan-dialog__btn pc-plan-dialog__btn--primary"
                onClick={() => onSuccess(result.features_created ?? result.ids?.length ?? 0)}
              >
                Done
              </button>
            </div>
          </footer>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="pc-plan-dialog__form">
          <header className="pc-plan-dialog__head">
            <h3>→ Promote to Harness</h3>
            <p>
              Creates harness features from the selected plan items via{' '}
              <code>plans:promote</code>. Each item's text becomes the feature
              title; items are marked done after promotion.
            </p>
          </header>
          <label className="pc-plan-dialog__field">
            <span>Harness slug</span>
            <input
              type="text"
              value={harnessSlug}
              onChange={(e) => setHarnessSlug(e.target.value)}
              placeholder="e.g. papercup, sheets"
              required
              autoFocus
            />
          </label>
          <div className="pc-plan-dialog__field">
            <span>Items to promote ({selected.size} / {candidateItems.length} selected)</span>
            <div style={{ maxHeight: '240px', overflowY: 'auto', marginTop: '4px' }}>
              {candidateItems.length === 0 ? (
                <p style={{ color: 'var(--fg-mute)', fontSize: '0.85em' }}>
                  No todo/wip items to promote.
                </p>
              ) : (
                candidateItems.map((item) => (
                  <label
                    key={item.id}
                    style={{
                      display: 'flex',
                      gap: '8px',
                      alignItems: 'flex-start',
                      padding: '4px 0',
                      cursor: 'pointer',
                      fontSize: '0.85em',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      onChange={() => toggleItem(item.id)}
                      style={{ marginTop: '2px', flexShrink: 0 }}
                    />
                    <span>
                      <code style={{ color: 'var(--fg-mute)', fontSize: '0.9em' }}>
                        {item.id}
                      </code>{' '}
                      {item.text}
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
          <DialogFooter
            error={error}
            submitting={submitting}
            submitLabel={`Promote ${selected.size} item${selected.size === 1 ? '' : 's'}`}
            onCancel={onClose}
            canSubmit={!!harnessSlug.trim() && selected.size > 0}
          />
        </form>
      )}
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
