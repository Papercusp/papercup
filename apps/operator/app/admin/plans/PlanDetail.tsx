'use client';

/**
 * Plan detail view — the two-pane shell's main pane.
 *
 * P-105 + P-107: pinned "Now" hero strip above PlanEditor, fed by
 * plans:get. P-301: a read/edit toggle (`pane` nuqs key, D-007) — Edit
 * mode mounts the full editor, tracks a draft buffer, and Saves through
 * `plans:set-content` with the compare-and-swap handshake (D-011). On a
 * stale conflict PlanConflictModal lets the human reload or keep their
 * draft. While editing (or while the file is locked) the structured-
 * action strip is disabled — an assisted write would clobber the
 * unsaved draft (D-007).
 */

import { useEffect, useRef, useState } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import {
  setPlanContent,
  staleConflictOf,
  usePlan,
  usePlanLint,
  usePlanLock,
  writeErrorOf,
} from './plans-api';
import PlanEditor from './PlanEditor';
import PlanJumpToItem from './PlanJumpToItem';
import LockBanner from './LockBanner';
import LintBanner from './LintBanner';
import PlanActions from './PlanActions';
import GitHistoryStrip from './GitHistoryStrip';
import PlanConflictModal from './PlanConflictModal';
import PlanStatusPopover, {
  resolveItemId,
  type PendingStatusFlip,
  type PlanStatus,
} from './PlanStatusPopover';

interface Props {
  slug: string;
  onClose: () => void;
  /** Reports unsaved-edit state up to PlansClient so navigation away
   *  from a dirty plan can prompt before discarding (Bug-1 guard). */
  onDirtyChange?: (dirty: boolean) => void;
}

export default function PlanDetail({ slug, onClose, onDirtyChange }: Props) {
  const { data, loading, error, refresh } = usePlan(slug);
  const archived = data?.archived ?? false;
  const { data: lock } = usePlanLock(data ? slug : null, archived);
  const [writeTick, setWriteTick] = useState(0);
  const { data: lintReport } = usePlanLint(data ? slug : null, writeTick);
  const editorScopeRef = useRef<HTMLDivElement>(null);

  // P-301 Edit-mode state.
  const [pane, setPane] = useQueryState(
    'pane',
    parseAsStringEnum(['read', 'edit']).withDefault('read'),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<PendingStatusFlip | null>(null);

  const onChanged = () => {
    refresh();
    setWriteTick((t) => t + 1);
  };

  const raw = data?.raw ?? data?.prose ?? '';
  const editing = pane === 'edit';
  const dirty = editing && draft !== null && draft !== raw;
  const locked = !!lock;

  // A plan freshly (re)loaded while not editing: clear any stale draft.
  useEffect(() => {
    if (!editing) setDraft(null);
  }, [editing, slug]);

  // Report dirty state up so PlansClient can guard navigation away
  // from an unsaved edit. The unmount cleanup reports `false` so a
  // close/view-switch leaves the guard disarmed.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  if (loading) {
    return (
      <DetailShell slug={slug} onClose={onClose}>
        <p className="pc-plans__placeholder">Loading {slug}…</p>
      </DetailShell>
    );
  }
  if (error) {
    return (
      <DetailShell slug={slug} onClose={onClose}>
        <div className="pc-plans__placeholder pc-plans__placeholder--error">
          <p>Failed to load plan:</p>
          <code>{error}</code>
          <button type="button" className="pc-plans__retry" onClick={refresh}>
            Retry
          </button>
        </div>
      </DetailShell>
    );
  }
  if (!data || data.error) {
    return (
      <DetailShell slug={slug} onClose={onClose}>
        <p className="pc-plans__placeholder">
          {data?.error ? `Server: ${data.error}` : 'No data.'}
        </p>
      </DetailShell>
    );
  }

  const title = (data.frontmatter?.title as string | undefined) ?? data.slug;

  const enterEdit = () => {
    setDraft(raw);
    setSaveError(null);
    setPane('edit');
  };
  const exitEdit = () => {
    if (dirty && !window.confirm('Discard unsaved edits to this plan?')) return;
    setDraft(null);
    setSaveError(null);
    setPane('read');
  };
  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await setPlanContent({
        slug: data.slug,
        content: draft,
        expectedHash: data.contentHash,
      });
      const stale = staleConflictOf(res);
      if (stale) {
        setConflict(stale.currentContent);
        return;
      }
      const err = writeErrorOf(res);
      if (err) {
        setSaveError(err);
        return;
      }
      // Saved — drop the draft, return to read mode, refetch.
      setDraft(null);
      setPane('read');
      onChanged();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailShell
      slug={slug}
      title={title}
      onClose={onClose}
      headerExtra={
        data.legacy ? null : (
          <EditToggle
            editing={editing}
            dirty={dirty}
            locked={locked}
            onEnter={enterEdit}
            onExit={exitEdit}
          />
        )
      }
    >
      <LockBanner lock={lock} />
      {data.now ? <NowHero state={data.now.state} next={data.now.next} /> : null}
      {data.legacy ? (
        <div className="pc-plans__legacy-banner">
          Legacy plan — frontmatter not parsed; rendering raw markdown.
        </div>
      ) : null}
      {!data.legacy ? (
        <PlanActions
          slug={data.slug}
          items={data.items}
          decisions={data.decisions}
          currentNow={data.now ?? null}
          onChanged={onChanged}
          disabled={editing || locked}
          disabledReason={
            editing
              ? 'Finish or discard your edits first'
              : locked
                ? `Locked by ${lock?.owner_label ?? lock?.owner}`
                : undefined
          }
        />
      ) : null}
      {editing ? (
        <EditBar
          dirty={dirty}
          saving={saving}
          locked={locked}
          error={saveError}
          onSave={save}
          onCancel={exitEdit}
        />
      ) : null}
      <LintBanner report={lintReport} scopeRef={editorScopeRef} />
      {!editing ? (
        <PlanJumpToItem
          items={data.items}
          decisions={data.decisions}
          scopeRef={editorScopeRef}
        />
      ) : null}
      <div ref={editorScopeRef} className="pc-plan-editor-scope">
        <PlanEditor
          value={editing ? (draft ?? raw) : raw}
          slug={slug}
          items={data.items}
          // P-205: while another shell holds the lock, the editor is
          // forced read-only even in edit mode — the draft is preserved
          // (value still resolves to `draft ?? raw`), so editing resumes
          // intact once the lock releases. The EditBar shows the lock
          // state and Save stays disabled.
          readOnly={!editing || locked}
          onChange={editing && !locked ? setDraft : undefined}
          onStatusClick={(target, status) => {
            // While editing, a setValue round-trip from set-status would
            // clobber the draft — D-007 disables structured writes in that
            // mode. The popover is read-mode-only.
            if (editing || locked) return;
            const itemId = resolveItemId(target);
            if (!itemId) return;
            setPendingStatus({ target, status: status as PlanStatus, itemId });
          }}
        />
      </div>
      <PlanStatusPopover
        pending={pendingStatus}
        slug={data.slug}
        onSuccess={onChanged}
        onClose={() => setPendingStatus(null)}
      />
      <GitHistoryStrip slug={data.slug} archived={archived} />
      <PlanConflictModal
        open={conflict !== null}
        currentContent={conflict ?? ''}
        onReload={() => {
          setConflict(null);
          setDraft(null);
          setPane('read');
          onChanged();
        }}
        onKeepEditing={() => setConflict(null)}
      />
    </DetailShell>
  );
}

function EditToggle({
  editing,
  dirty,
  locked,
  onEnter,
  onExit,
}: {
  editing: boolean;
  dirty: boolean;
  locked: boolean;
  onEnter: () => void;
  onExit: () => void;
}) {
  if (editing) {
    return (
      <button type="button" className="pc-plans__editbtn is-on" onClick={onExit}>
        {dirty ? 'Exit edit (unsaved)' : 'Exit edit'}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="pc-plans__editbtn"
      onClick={onEnter}
      disabled={locked}
      aria-label={locked ? 'Plan is locked by another shell' : 'Edit the raw markdown'}
    >
      Edit
    </button>
  );
}

function EditBar({
  dirty,
  saving,
  locked,
  error,
  onSave,
  onCancel,
}: {
  dirty: boolean;
  saving: boolean;
  locked: boolean;
  error: string | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="pc-editbar">
      <div className="pc-editbar__row">
        <span className="pc-editbar__hint">
          {locked
            ? 'Locked by another shell — saving is disabled until it releases.'
            : dirty
              ? 'Unsaved changes.'
              : 'No changes yet.'}
        </span>
        <span className="pc-editbar__spacer" />
        <button
          type="button"
          className="pc-editbar__btn"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="pc-editbar__btn pc-editbar__btn--primary"
          onClick={onSave}
          disabled={saving || locked || !dirty}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error ? <p className="pc-editbar__error">{error}</p> : null}
    </div>
  );
}

function DetailShell({
  slug,
  title,
  onClose,
  headerExtra,
  children,
}: {
  slug: string;
  title?: string;
  onClose: () => void;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="pc-plans__detail" aria-label={`Plan ${slug}`}>
      <header className="pc-plans__detail-head">
        <button type="button" className="pc-plans__back" onClick={onClose}>
          ← All plans
        </button>
        <div className="pc-plans__detail-title">
          <span className="pc-plans__detail-kicker">Plan detail</span>
          <h2>{title ?? slug}</h2>
          {title && title !== slug ? (
            <span className="pc-plans__detail-slug">{slug}</span>
          ) : null}
        </div>
        <span className="pc-plans__detail-spacer" />
        {headerExtra}
      </header>
      {children}
    </section>
  );
}

function NowHero({ state, next }: { state: string | null; next: string | null }) {
  if (!state && !next) return null;
  return (
    <section className="pc-now-hero" aria-label="Now">
      <span className="pc-now-hero__kicker">Now</span>
      {state ? (
        <div className="pc-now-hero__row">
          <span className="pc-now-hero__label">State</span>
          <p>{state}</p>
        </div>
      ) : null}
      {next ? (
        <div className="pc-now-hero__row">
          <span className="pc-now-hero__label">Next</span>
          <p>{next}</p>
        </div>
      ) : null}
    </section>
  );
}
