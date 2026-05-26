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

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSyncQuery } from '@restart/sync';
import { parseAsInteger, parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import {
  setPlanContent,
  staleConflictOf,
  usePlan,
  usePlanLint,
  usePlanLock,
  writeErrorOf,
} from './plans-api';
import PlanEditor from './PlanEditor';
import { buildFeatureSummary, type PromotedFeature } from './plan-renderers';
import PlanJumpToItem from './PlanJumpToItem';
import LockBanner from './LockBanner';
import LintBanner from './LintBanner';
import PlanActions from './PlanActions';
import RevisionsPanel from './RevisionsPanel';
import RevisionDiffModal from './RevisionDiffModal';
import RevisionConversationModal from './RevisionConversationModal';
import AgentsPanel from './AgentsPanel';
import PlanConflictModal from './PlanConflictModal';
import PlanStatusPopover, {
  resolveItemId,
  type PendingStatusFlip,
  type PlanStatus as PlanItemStatus,
} from './PlanStatusPopover';
import type { PlanStatus, PlanStartStatus } from './plans-api';

interface Props {
  slug: string;
  onClose: () => void;
  /** Reports unsaved-edit state up to PlansClient so navigation away
   *  from a dirty plan can prompt before discarding (Bug-1 guard). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Operational start state from harness_plan_status. */
  startStatus?: PlanStartStatus;
  /** Called after a successful start/pause so the rail can refresh. */
  onStartStatusChange?: (newStatus: PlanStartStatus) => void;
}

export default function PlanDetail({ slug, onClose, onDirtyChange, startStatus, onStartStatusChange }: Props) {
  const { data, loading, error, refresh } = usePlan(slug);
  const archived = data?.archived ?? false;
  const { data: lock } = usePlanLock(data ? slug : null, archived);
  const [writeTick, setWriteTick] = useState(0);
  const { data: lintReport } = usePlanLint(data ? slug : null, writeTick);
  const editorScopeRef = useRef<HTMLDivElement>(null);

  // P-013: subscribe to features promoted from this plan for live status badges.
  const { data: promotedRaw } = useSyncQuery<{
    featureId: string;
    harnessSlug: string;
    title: string | null;
    status: string | null;
  }>({
    queryName: 'featuresConsolidated.byPlanSlug',
    args: { planSlug: slug },
  });
  const promotedFeatures = useMemo(
    (): PromotedFeature[] => (Array.isArray(promotedRaw) ? promotedRaw : []),
    [promotedRaw],
  );
  const featureSummary = useMemo(
    () => buildFeatureSummary(promotedFeatures),
    [promotedFeatures],
  );

  // P-301 Edit-mode state.
  const [pane, setPane] = useQueryState(
    'pane',
    parseAsStringEnum(['read', 'edit']).withDefault('read'),
  );
  // plan-agent-launch P-020/P-021: which view of the plan is active.
  // 'editor' = the markdown editor; 'revisions' = the Revisions
  // panel (P-017); 'agents' = the Agents tab (P-021). nuqs-backed so
  // a tab + a deep-link (?rev= / ?convo= / ?run=) survive reload.
  const [tab, setTab] = useQueryState(
    'tab',
    parseAsStringEnum(['editor', 'revisions', 'agents']).withDefault('editor'),
  );
  // P-018/P-019 modals — lifted from RevisionsPanel so a deep link
  // `?tab=editor&rev=42` still shows the modal even when the panel
  // itself isn't mounted. RevisionsPanel uses the same nuqs keys to
  // drive open from row clicks; we render the modals here.
  const [openRev, setOpenRev] = useQueryState('rev', parseAsInteger);
  const [openConvo, setOpenConvo] = useQueryState('convo', parseAsInteger);
  const [jump, setJump] = useQueryState('jump', parseAsString);
  const [draft, setDraft] = useState<string | null>(null);
  // P-025 (D-009): the "what changed & why" the editor's Save
  // surfaces. Carried into setPlanContent → recorded on the new
  // plan_revisions row → seeded into the next agent's launch bundle.
  // Cleared on enterEdit/exitEdit/save together with the draft.
  const [rationale, setRationale] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<PendingStatusFlip | null>(null);

  const onChanged = () => {
    refresh();
    setWriteTick((t) => t + 1);
  };

  const raw = data?.raw ?? data?.prose ?? '';
  // In read mode the parsed frontmatter is already surfaced in
  // FrontmatterCard above the editor. Stripping the leading
  // `---\n…\n---\n` block from the rendered markdown prevents
  // Vditor.preview from showing it as a low-contrast paragraph
  // (was dark-blue-on-dark-blue and unreadable).
  const strippedRaw = data?.legacy ? raw : stripFrontmatter(raw);
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

  // Cross-plan inbox/actionable clicks deep-link here with ?jump=P-NNN.
  // Vditor preview rendering is async, so retry briefly until the
  // decorated markdown nodes exist, then clear the URL param.
  useEffect(() => {
    if (!jump || tab !== 'editor' || editing) return;
    let cancelled = false;
    const delays = [0, 80, 200, 500, 1000];
    const timers = delays.map((delay) =>
      window.setTimeout(() => {
        if (cancelled) return;
        if (scrollPlanTarget(editorScopeRef.current, jump)) {
          cancelled = true;
          void setJump(null);
        }
      }, delay),
    );
    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [editing, jump, setJump, slug, strippedRaw, tab]);

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
  const planStatus = (data.frontmatter?.status as PlanStatus | undefined) ?? undefined;
  const draftSource: 'user' | 'scoper' | null =
    planStatus === 'draft' ? (data.slug.startsWith('scoper-proposal-') ? 'scoper' : 'user') : null;

  const enterEdit = () => {
    setDraft(raw);
    setRationale('');
    setSaveError(null);
    setPane('edit');
    // P-020: clicking "Edit" from the Revisions tab implies "edit
    // this plan" — switch the tab too so the editor is actually
    // visible.
    setTab('editor');
  };
  const exitEdit = () => {
    if (dirty && !window.confirm('Discard unsaved edits to this plan?')) return;
    setDraft(null);
    setRationale('');
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
        rationale: rationale.trim() || undefined,
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
      // Saved — drop the draft + rationale, return to read mode, refetch.
      setDraft(null);
      setRationale('');
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
      kickerExtra={
        draftSource ? (
          <span
            className={`pc-pill pc-pill--source-${draftSource}`}
            title={draftSource === 'scoper' ? 'Authored by the scoper' : 'Authored by you'}
            style={{ marginLeft: 8 }}
          >
            {draftSource === 'scoper' ? 'scoper' : 'you'}
          </span>
        ) : null
      }
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
      {!data.legacy && data.frontmatter ? (
        <FrontmatterCard slug={data.slug} frontmatter={data.frontmatter} />
      ) : null}
      {data.now ? (
        <NowHero
          state={data.now.state}
          next={data.now.next}
          featureSummary={featureSummary}
        />
      ) : null}
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
          planTitle={title}
          planStatus={planStatus}
          startStatus={startStatus}
          onStartStatusChange={onStartStatusChange}
          onChanged={onChanged}
          onRejected={onClose}
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
          rationale={rationale}
          onRationaleChange={setRationale}
          onSave={save}
          onCancel={exitEdit}
        />
      ) : null}
      <LintBanner report={lintReport} scopeRef={editorScopeRef} />
      <PlanTabStrip
        tab={tab}
        editing={editing}
        onTab={(next) => {
          if (editing && next !== 'editor') {
            // Going away from the editor mid-edit would visually
            // discard the draft. Confirm — same gate as exitEdit's
            // "discard unsaved edits".
            if (dirty && !window.confirm('Leave the editor with unsaved edits?')) {
              return;
            }
          }
          setTab(next);
        }}
      />
      {tab === 'editor' ? (
        <>
      {!editing ? (
        <PlanJumpToItem
          items={data.items}
          decisions={data.decisions}
          scopeRef={editorScopeRef}
        />
      ) : null}
      <div ref={editorScopeRef} className="pc-plan-editor-scope">
        <PlanEditor
          value={editing ? (draft ?? raw) : strippedRaw}
          slug={slug}
          items={data.items}
          promotedFeatures={promotedFeatures.length > 0 ? promotedFeatures : undefined}
          linkedFeatures={data.linkedFeatures}
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
            setPendingStatus({ target, status: status as PlanItemStatus, itemId });
          }}
        />
      </div>
      <PlanStatusPopover
        pending={pendingStatus}
        slug={data.slug}
        onSuccess={onChanged}
        onClose={() => setPendingStatus(null)}
      />
        </>
      ) : null}
      {tab === 'revisions' ? <RevisionsPanel slug={data.slug} /> : null}
      {tab === 'agents' ? (
        <AgentsPanel
          slug={data.slug}
          planTitle={title}
          currentContentHash={data.contentHash}
        />
      ) : null}
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
      {/* Revision modals are mounted here (P-020) — not under the
       *  Revisions tab — so a deep link `?rev=42` / `?convo=42`
       *  resolves regardless of which tab is active. */}
      <RevisionDiffModal
        revisionId={openRev}
        onClose={() => setOpenRev(null)}
      />
      <RevisionConversationModal
        revisionId={openConvo}
        onClose={() => setOpenConvo(null)}
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
  rationale,
  onRationaleChange,
  onSave,
  onCancel,
}: {
  dirty: boolean;
  saving: boolean;
  locked: boolean;
  error: string | null;
  rationale: string;
  onRationaleChange: (v: string) => void;
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
      {/* P-025 (D-009): the rationale input. Optional — D-009's
       *  "expectation scales with the write" applies — but agents
       *  launched from this plan see whatever is recorded here as
       *  always-loaded context, so a substantive edit should fill it
       *  in. Bound to the editor lifecycle (cleared on enter/exit/save). */}
      <div className="pc-editbar__row pc-editbar__row--rationale">
        <input
          type="text"
          className="pc-editbar__rationale"
          placeholder="What changed & why (optional — seeded into next agent launch)"
          value={rationale}
          onChange={(e) => onRationaleChange(e.target.value)}
          disabled={saving}
          aria-label="Rationale for this edit"
        />
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
  kickerExtra,
  children,
}: {
  slug: string;
  title?: string;
  onClose: () => void;
  headerExtra?: React.ReactNode;
  kickerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="pc-plans__detail" aria-label={`Plan ${slug}`}>
      <header className="pc-plans__detail-head">
        <button type="button" className="pc-plans__back" onClick={onClose}>
          ← All plans
        </button>
        <div className="pc-plans__detail-title">
          <span className="pc-plans__detail-kicker">
            Plan detail
            {kickerExtra}
          </span>
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

type PlanDetailTab = 'editor' | 'revisions' | 'agents';

/**
 * Top-level tab strip — P-020/P-021. Switches between the editor, the
 * Revisions panel, and the Agents tab. The active tab is `?tab=`
 * (nuqs). The strip is a `tablist`; the `editing` hint shows a
 * "unsaved edits" affordance on the non-editor tabs.
 */
function PlanTabStrip({
  tab,
  editing,
  onTab,
}: {
  tab: PlanDetailTab;
  editing: boolean;
  onTab: (next: PlanDetailTab) => void;
}) {
  return (
    <div className="pc-plans__tabs" role="tablist" aria-label="Plan view">
      <TabButton tab="editor" active={tab} onTab={onTab} label="Editor" />
      <TabButton
        tab="revisions"
        active={tab}
        onTab={onTab}
        label="Revisions"
        hint={editing ? 'unsaved edits' : undefined}
      />
      <TabButton
        tab="agents"
        active={tab}
        onTab={onTab}
        label="Agents"
        hint={editing ? 'unsaved edits' : undefined}
      />
    </div>
  );
}

function TabButton({
  tab,
  active,
  onTab,
  label,
  hint,
}: {
  tab: PlanDetailTab;
  active: PlanDetailTab;
  onTab: (next: PlanDetailTab) => void;
  label: string;
  hint?: string;
}) {
  const isActive = tab === active;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      className={`pc-plans__tab${isActive ? ' is-active' : ''}`}
      onClick={() => onTab(tab)}
      title={hint}
    >
      {label}
      {hint ? <span className="pc-plans__tab-hint"> · {hint}</span> : null}
    </button>
  );
}

/** Leading `---\nyaml\n---\n` YAML frontmatter — Vditor renders this as
 *  a low-contrast paragraph in read mode. The parsed values are already
 *  available via plans:get → data.frontmatter, so we strip them from
 *  the prose and render them in FrontmatterCard instead. */
function stripFrontmatter(src: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  return m ? src.slice(m[0].length) : src;
}

function FrontmatterCard({
  slug,
  frontmatter,
}: {
  slug: string;
  frontmatter: Record<string, unknown>;
}) {
  const rows: Array<[string, string]> = [];
  const formatScalar = (val: unknown): string | null => {
    if (val === undefined || val === null) return null;
    if (val instanceof Date) {
      const iso = val.toISOString();
      // YYYY-MM-DD if the time component is zeroed (typical for plan
      // `created:` / `updated:` fields written as bare dates).
      return /T00:00:00\.000Z$/.test(iso) ? iso.slice(0, 10) : iso;
    }
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      const s = String(val).trim();
      return s.length === 0 ? null : s;
    }
    if (Array.isArray(val)) {
      const parts = val.map((v) => formatScalar(v)).filter((s): s is string => s != null);
      return parts.length > 0 ? parts.join(', ') : null;
    }
    // Nested object — skip rather than render `[object Object]`. The
    // human-relevant fields are scalars (title/slug/status/created/
    // updated/owner); structured side-data isn't useful in a metadata
    // bar.
    return null;
  };
  const push = (label: string, val: unknown) => {
    const s = formatScalar(val);
    if (s == null) return;
    rows.push([label, s]);
  };
  push('slug', (frontmatter.slug as string | undefined) ?? slug);
  push('status', frontmatter.status);
  push('created', frontmatter.created);
  push('updated', frontmatter.updated);
  push('owner', frontmatter.owner);
  for (const k of Object.keys(frontmatter)) {
    if (['title', 'slug', 'status', 'created', 'updated', 'owner'].includes(k)) continue;
    push(k, frontmatter[k]);
  }
  if (rows.length === 0) return null;
  return (
    <section className="pc-plan-fm" aria-label="Plan metadata">
      <dl className="pc-plan-fm__grid">
        {rows.map(([label, val]) => (
          <div className="pc-plan-fm__row" key={label}>
            <dt className="pc-plan-fm__key">{label}</dt>
            <dd className="pc-plan-fm__val">{val}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function NowHero({
  state,
  next,
  featureSummary,
}: {
  state: string | null;
  next: string | null;
  featureSummary?: string | null;
}) {
  if (!state && !next) return null;
  return (
    <section className="pc-now-hero" aria-label="Now">
      <span className="pc-now-hero__kicker">Now</span>
      {featureSummary ? (
        <div className="pc-now-hero__row">
          <span className="pc-now-hero__label">Features</span>
          <p style={{ color: 'var(--fg-mute)', fontSize: '0.85em' }}>{featureSummary}</p>
        </div>
      ) : null}
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

function scrollPlanTarget(scope: HTMLElement | null, id: string): boolean {
  if (!scope) return false;
  let dest: HTMLElement | null = null;
  if (id.startsWith('P-')) {
    dest = scope.querySelector<HTMLElement>(`[data-plan-item="${id}"]`);
  } else {
    dest =
      (scope.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null) ??
      findHeadingByText(scope, id);
  }
  if (!dest) return false;
  dest.scrollIntoView({ block: 'center', behavior: 'smooth' });
  dest.classList.add('pc-plan-highlight');
  window.setTimeout(() => dest?.classList.remove('pc-plan-highlight'), 1500);
  return true;
}

function findHeadingByText(scope: HTMLElement, id: string): HTMLElement | null {
  for (const h of Array.from(scope.querySelectorAll<HTMLElement>('h3'))) {
    if ((h.textContent ?? '').trim().startsWith(id)) return h;
  }
  return null;
}
