'use client';

/**
 * CreateHarnessPicker — modal picker for adding a new harness to the workspace.
 *
 * Implements Phase 1a P-012 (papercusp-dogfood-phase1a-workspace-ui-shell-2026-05-24):
 *   P-012a  4-entry picker renders with coming-soon placeholders
 *   P-012b  Entry 1 (New local directory) happy path
 *   P-012c  Entry 3 (Existing local repo) happy path
 *   P-012d  Per-error-code error messages
 *
 * Entries are grouped under "Local" (new / existing local) and "Shared".
 * The GitHub-URL entry is the hive-level Entry 2 (hive-from-github-url
 * P-011/P-012, gated on HIVE_FROM_GITHUB_URL — flag off keeps the legacy
 * coming-soon stub); with it on, the Entry-4 harness-link card demotes to a
 * secondary "I have a link" affordance (still fully functional, D-001).
 *
 * The SELECTED entry rides the `?picker=` nuqs param (user-meaningful state →
 * URL, the house rule); form drafts inside each entry stay useState.
 */

import { useState, useRef, type FormEvent, type ReactNode } from 'react';
import { parseAsStringEnum, useQueryState } from 'nuqs';
import { Modal } from './Modal';
import { toast } from 'sonner';
import { FLAGS } from '@papercusp/flags';
import { useFlag } from '@/lib/flag-hooks';
import { EntryHarnessLinkForm } from './EntryHarnessLinkForm';
import { EntryGithubUrlForm } from './EntryGithubUrlForm';
import { ShareWizard } from './ShareWizard';
import { useViewer } from '../adv/harnesses/useViewer';

// ── Types ──────────────────────────────────────────────────────────────────

/** The non-default steps — the `?picker=` nuqs values ('picker' = param unset). */
const ENTRY_STEPS = [
  'new-local',
  'existing-local',
  'new-hive',
  'github-url',
  'harness-link',
  'share-offer',
] as const;
type EntryStep = (typeof ENTRY_STEPS)[number];

type Step = 'picker' | EntryStep;

/**
 * The creation fork (harnesses-tab-hive-model D-005 / P-010). `standalone` and
 * `into-hive` share the same "how to add" entry cards — the only difference is
 * whether the create stamps a membership edge to the selected hive (P-011).
 * `new-hive` is its own form (stand up a kind:'hive' home). The toggle only
 * offers `into-hive` when a hive scope is actually selected.
 */
type CreateMode = 'standalone' | 'into-hive';

interface CreateResult {
  ok: boolean;
  project: { slug: string; path: string };
}

interface ApiError {
  error: string;
  code?: string;
  detail?: string;
}

// ── Error message map ──────────────────────────────────────────────────────

function friendlyError(code: string | undefined, raw: string): string {
  switch (code) {
    case 'dest_exists':
      return 'A directory with that name already exists. Choose a different name or pick a different parent directory.';
    case 'invalid_path':
      return `That path is invalid: ${raw}`;
    case 'parent_missing':
      return 'Parent directory not found or not a directory. Check the path and try again.';
    case 'git_missing':
      return 'git was not found in PATH. Install git and try again.';
    default:
      return raw || 'An unexpected error occurred.';
  }
}

// ── Small shared helpers ───────────────────────────────────────────────────

function Label({ children }: { children: ReactNode }) {
  return (
    <label style={{ display: 'block', marginBottom: 14 }}>
      {children}
    </label>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-dim)', marginBottom: 4, fontWeight: 500 }}>
      {children}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '7px 10px',
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 5,
  color: 'var(--fg)',
  fontFamily: 'inherit',
  fontSize: 13,
  boxSizing: 'border-box',
};

function HintText({ children }: { children: ReactNode }) {
  return (
    <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--fg-mute)' }}>
      {children}
    </p>
  );
}

function BackBtn({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      style={{ background: 'none', border: 'none', color: 'var(--fg-dim)', cursor: 'pointer', padding: 0, fontSize: 13, marginBottom: 20 }}
    >
      ← Back
    </button>
  );
}

function SubmitRow({ busy, label, onBack }: { busy: boolean; label: string; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        style={{ padding: '7px 14px', fontSize: 13, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)', borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={busy}
        style={{ padding: '7px 16px', fontSize: 13, background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--accent-ink, #051827)', borderRadius: 5, cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1, fontWeight: 600 }}
      >
        {busy ? 'Creating…' : label}
      </button>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" style={{ background: 'var(--bad-bg, rgba(255,80,80,0.08))', border: '1px solid var(--bad)', color: 'var(--bad)', borderRadius: 5, padding: '8px 12px', fontSize: 13, marginBottom: 14 }}>
      {message}
    </div>
  );
}

// ── Entry 1 form — new local directory ────────────────────────────────────

function NewLocalForm({ onBack, onSuccess, hive }: { onBack: () => void; onSuccess: (slug: string) => void; hive?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const parentDirRef = useRef<HTMLInputElement>(null);
  const folderNameRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const slug = slugRef.current?.value.trim() ?? '';
    const parentDir = parentDirRef.current?.value.trim() ?? '';
    const folderName = folderNameRef.current?.value.trim() ?? '';
    if (!slug || !parentDir || !folderName) {
      setError('All fields are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/harness/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `hive` (P-011): when adding into the selected hive, the route stamps
        // the membership edge to that scope (formal hive_slug / legacy parent_slug).
        body: JSON.stringify({ slug, parentDir, folderName, ...(hive ? { hive } : {}) }),
      });
      if (!res.ok) {
        const body: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError(friendlyError(body.code, body.error));
        setBusy(false);
        return;
      }
      const data: CreateResult = await res.json();
      toast.success(`Harness '${data.project.slug}' created at ${data.project.path}`);
      onSuccess(data.project.slug);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Network error');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <BackBtn onBack={onBack} />
      <h2 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>New local directory</h2>
      {error && <ErrorBanner message={error} />}
      <Label>
        <FieldLabel>Harness slug</FieldLabel>
        <input ref={slugRef} type="text" placeholder="my-project" style={inputStyle} autoFocus pattern="[a-z0-9][a-z0-9-]*" title="lowercase alphanumeric, hyphens OK" />
        <HintText>Lowercase, hyphens OK. Used as the folder name inside the state dir.</HintText>
      </Label>
      <Label>
        <FieldLabel>Parent directory</FieldLabel>
        <input ref={parentDirRef} type="text" placeholder="/home/user/projects" style={inputStyle} />
        <HintText>Absolute path to the directory that will contain the new folder.</HintText>
      </Label>
      <Label>
        <FieldLabel>Folder name</FieldLabel>
        <input ref={folderNameRef} type="text" placeholder="my-project" style={inputStyle} />
        <HintText>The new directory to create inside the parent. Must not already exist.</HintText>
      </Label>
      <SubmitRow busy={busy} label="Create harness" onBack={onBack} />
    </form>
  );
}

// ── Entry 3 form — existing local repo ────────────────────────────────────

function ExistingLocalForm({ onBack, onSuccess, hive }: { onBack: () => void; onSuccess: (slug: string) => void; hive?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const slug = slugRef.current?.value.trim() ?? '';
    const path = pathRef.current?.value.trim() ?? '';
    if (!slug || !path) {
      setError('Both fields are required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/harness/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `hive` (P-011): stamps the membership edge to the selected hive scope.
        body: JSON.stringify({ slug, path, ...(hive ? { hive } : {}) }),
      });
      if (!res.ok) {
        const body: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError(friendlyError(body.code, body.error));
        setBusy(false);
        return;
      }
      const data: CreateResult = await res.json();
      toast.success(`Harness '${data.project.slug}' linked in place — ${data.project.path} (folder not moved)`);
      onSuccess(data.project.slug);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Network error');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <BackBtn onBack={onBack} />
      <h2 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Existing local repo</h2>
      {error && <ErrorBanner message={error} />}
      <div
        style={{
          background: 'var(--bg-2)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 16,
          fontSize: 12.5,
          lineHeight: 1.5,
          color: 'var(--fg-dim)',
        }}
      >
        <span style={{ marginRight: 6 }}>🔗</span>
        <strong style={{ color: 'var(--fg)' }}>Links the folder in place</strong> — your repo stays exactly
        where it is; nothing is moved or copied. The workspace just records a pointer to this path. The same
        folder can be linked into more than one workspace (e.g. to try different prompts on it).
      </div>
      <Label>
        <FieldLabel>Harness slug</FieldLabel>
        <input ref={slugRef} type="text" placeholder="my-project" style={inputStyle} autoFocus pattern="[a-z0-9][a-z0-9-]*" title="lowercase alphanumeric, hyphens OK" />
        <HintText>Lowercase, hyphens OK.</HintText>
      </Label>
      <Label>
        <FieldLabel>Path to repo</FieldLabel>
        <input ref={pathRef} type="text" placeholder="/home/user/projects/my-project" style={inputStyle} />
        <HintText>Absolute path to an existing git repository or project directory. Stays where it is — linked, not moved.</HintText>
      </Label>
      <SubmitRow busy={busy} label="Add harness" onBack={onBack} />
    </form>
  );
}

// ── New-hive form — stand up a kind:'hive' home (the Queen/pot blueprint) ──

function NewHiveForm({ onBack, onSuccess, hiveLabel }: { onBack: () => void; onSuccess: (slug: string) => void; hiveLabel: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const slugRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const slug = slugRef.current?.value.trim() ?? '';
    if (!slug) {
      setError('A slug is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/harness/hives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) {
        const body: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError(body.error || `Could not create ${hiveLabel.toLowerCase()}.`);
        setBusy(false);
        return;
      }
      const data = (await res.json()) as { ok: boolean; project: { slug: string } };
      toast.success(`${hiveLabel} '${data.project.slug}' created — the Queen is provisioning its fleet.`);
      onSuccess(data.project.slug);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Network error');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)}>
      <BackBtn onBack={onBack} />
      <h2 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>New {hiveLabel.toLowerCase()} from blueprint</h2>
      {error && <ErrorBanner message={error} />}
      <div
        style={{
          background: 'var(--bg-2)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '10px 12px',
          marginBottom: 16,
          fontSize: 12.5,
          lineHeight: 1.5,
          color: 'var(--fg-dim)',
        }}
      >
        <span style={{ marginRight: 6 }}>👑</span>
        Stands up a new {hiveLabel.toLowerCase()} home running the <strong style={{ color: 'var(--fg)' }}>pot</strong> blueprint —
        a Queen that surveys the work frontier and places it onto a fleet of bees. You can add member harnesses into it afterward.
      </div>
      <Label>
        <FieldLabel>{hiveLabel} slug</FieldLabel>
        <input ref={slugRef} type="text" placeholder="my-hive" style={inputStyle} autoFocus pattern="[a-z0-9][a-z0-9-]*" title="lowercase alphanumeric, hyphens OK" />
        <HintText>Lowercase, hyphens OK. The home harness slug for the new {hiveLabel.toLowerCase()}.</HintText>
      </Label>
      <SubmitRow busy={busy} label={`Create ${hiveLabel.toLowerCase()}`} onBack={onBack} />
    </form>
  );
}

// ── Coming-soon placeholder ────────────────────────────────────────────────

function ComingSoonStub({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div>
      <BackBtn onBack={onBack} />
      <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{title}</h2>
      <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 20, textAlign: 'center' }}>
        <span style={{ fontSize: 28, display: 'block', marginBottom: 10 }}>🚧</span>
        <p style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 14 }}>Coming soon</p>
        <p style={{ margin: 0, color: 'var(--fg-dim)', fontSize: 13, lineHeight: 1.5 }}>
          This entry type requires GitHub authentication and repository cloning, which isn&rsquo;t available yet.
        </p>
      </div>
      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <button
          type="button"
          onClick={onBack}
          style={{ padding: '7px 14px', fontSize: 13, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)', borderRadius: 5, cursor: 'pointer' }}
        >
          Back
        </button>
      </div>
    </div>
  );
}

// ── Picker cards ───────────────────────────────────────────────────────────

interface PickerEntry {
  id: Step;
  label: string;
  description: string;
  icon: string;
  /** Routes to a not-yet-available stub; renders dimmed (no visible badge). */
  comingSoon?: boolean;
}

interface PickerSection {
  heading: string;
  subheading?: string;
  entries: PickerEntry[];
}

/**
 * Sections are built per-render: the GitHub-URL entry's copy + routing depend
 * on the HIVE_FROM_GITHUB_URL flag (P-012) and the hive label is lexicon-bound.
 * With the flag ON the Entry-4 harness-link card demotes out of the grid — it
 * becomes the "I have a link" secondary affordance under the Shared section.
 */
function buildSections(opts: { hiveLower: string; githubUrlEnabled: boolean }): PickerSection[] {
  const { hiveLower, githubUrlEnabled } = opts;
  return [
    {
      heading: 'Local',
      entries: [
        {
          id: 'new-local',
          label: 'New local directory',
          description: 'Create a new folder, run git init, and register it as a harness.',
          icon: '📁',
        },
        {
          id: 'existing-local',
          label: 'Existing local repo',
          description: 'Register an existing local directory or git repo as a harness.',
          icon: '📂',
        },
      ],
    },
    {
      heading: 'Shared',
      subheading: 'Work on these repositories collaboratively.',
      entries: [
        githubUrlEnabled
          ? {
              id: 'github-url',
              label: 'GitHub URL',
              description: `Create a ${hiveLower} from a GitHub repository. Forks nothing — clones and registers; auto-publishes to the directory.`,
              icon: '🐙',
            }
          : {
              id: 'github-url',
              label: 'GitHub URL',
              description: 'Clone a GitHub repository and register it. Requires GitHub auth.',
              icon: '🐙',
              comingSoon: true,
            },
        // Flag off: the harness-link card keeps its legacy primary spot.
        ...(githubUrlEnabled
          ? []
          : [
              {
                id: 'harness-link' as Step,
                label: 'Harness link',
                description: 'Join a shared harness via a papercusp://harness?… invite link.',
                icon: '🔗',
              },
            ]),
      ],
    },
  ];
}

/**
 * The creation fork toggle (D-005 / P-010): New hive · Add to <hive> · Standalone.
 * "Add to <hive>" only appears when a hive scope is selected.
 */
function ForkToggle({
  mode,
  onMode,
  onNewHive,
  hiveScope,
  hiveLabel,
}: {
  mode: CreateMode;
  onMode: (m: CreateMode) => void;
  onNewHive: () => void;
  hiveScope: string | null;
  hiveLabel: string;
}) {
  const lower = hiveLabel.toLowerCase();
  const btn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '7px 10px',
    fontSize: 12.5,
    fontWeight: active ? 600 : 500,
    background: active ? 'var(--accent)' : 'var(--bg-2)',
    color: active ? 'var(--accent-ink, #051827)' : 'var(--fg-dim)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });
  return (
    <div role="tablist" aria-label="Creation mode" style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
      <button type="button" role="tab" onClick={onNewHive} style={btn(false)} title={`Stand up a new ${lower} home running the Queen blueprint`}>
        👑 New {lower}
      </button>
      {hiveScope && (
        <button type="button" role="tab" aria-selected={mode === 'into-hive'} onClick={() => onMode('into-hive')} style={btn(mode === 'into-hive')} title={`Add the new harness into ${hiveScope}`}>
          Add to {hiveScope}
        </button>
      )}
      <button type="button" role="tab" aria-selected={mode === 'standalone'} onClick={() => onMode('standalone')} style={btn(mode === 'standalone')} title="A standalone harness with no hive membership">
        Standalone
      </button>
    </div>
  );
}

function PickerStep({
  onSelect,
  mode,
  onMode,
  hiveScope,
  hiveLabel,
  githubUrlEnabled,
}: {
  onSelect: (step: Step) => void;
  mode: CreateMode;
  onMode: (m: CreateMode) => void;
  hiveScope: string | null;
  hiveLabel: string;
  githubUrlEnabled: boolean;
}) {
  const intoHive = mode === 'into-hive' && hiveScope;
  const sections = buildSections({ hiveLower: hiveLabel.toLowerCase(), githubUrlEnabled });
  return (
    <div>
      <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Add a {hiveLabel.toLowerCase() === 'hive' ? 'harness' : 'harness'}</h2>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-dim)' }}>
        {intoHive
          ? <>New harnesses will be added into <code>{hiveScope}</code>.</>
          : 'Choose how to add a new harness to this workspace.'}
      </p>
      <ForkToggle mode={mode} onMode={onMode} onNewHive={() => onSelect('new-hive')} hiveScope={hiveScope} hiveLabel={hiveLabel} />
      {sections.map((section) => (
        <div key={section.heading} style={{ marginBottom: 18 }}>
          <div style={{ marginBottom: 10 }}>
            <h3
              style={{
                margin: 0,
                fontSize: 12,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--fg-dim)',
              }}
            >
              {section.heading}
            </h3>
            {section.subheading && (
              <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--fg-mute)' }}>
                {section.subheading}
              </p>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {section.entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSelect(entry.id)}
                className="pc-create-harness-entry"
                style={{
                  textAlign: 'left',
                  padding: 16,
                  background: 'var(--bg-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  cursor: 'pointer',
                  position: 'relative',
                  transition: 'border-color 0.1s',
                }}
              >
                <span style={{ fontSize: 24, display: 'block', marginBottom: 8 }}>{entry.icon}</span>
                <strong style={{ fontSize: 13, display: 'block', marginBottom: 4, color: entry.comingSoon ? 'var(--fg-mute)' : 'var(--fg)' }}>
                  {entry.label}
                </strong>
                <span style={{ fontSize: 12, color: 'var(--fg-mute)', lineHeight: 1.4, display: 'block' }}>
                  {entry.description}
                </span>
              </button>
            ))}
          </div>
          {/* Entry-4 demotion (hive-from-github-url D-001/P-012): with the
              GitHub-URL door live, the harness-link card becomes a secondary
              "I have a link" affordance — same flow, lower billing. */}
          {section.heading === 'Shared' && githubUrlEnabled && (
            <button
              type="button"
              onClick={() => onSelect('harness-link')}
              style={{ background: 'none', border: 'none', color: 'var(--fg-dim)', cursor: 'pointer', padding: 0, fontSize: 12, marginTop: 10, textDecoration: 'underline' }}
            >
              I have a harness link (papercusp://…) →
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Public component ───────────────────────────────────────────────────────

interface CreateHarnessPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called after a harness is successfully created/added. `opts.hive` names the
   * hive the new harness was added INTO (add-into-hive mode, P-011) so the caller
   * can land it as the focused member; absent ⇒ a standalone / new-hive root.
   */
  onCreated?: (slug: string, opts?: { hive?: string }) => void;
  /**
   * The currently-selected hive scope (`?slug=`), if any (harnesses-tab-hive-model
   * P-010/P-011). When set, the picker offers "Add to <hive>" and defaults to it;
   * the add-into-hive create stamps the membership edge to this scope.
   */
  hiveScope?: string | null;
  /** Lexicon label for a hive (D-006 — the parent passes the resolved term). Default "Hive". */
  hiveLabel?: string;
}

export function CreateHarnessPicker({ open, onOpenChange, onCreated, hiveScope = null, hiveLabel = 'Hive' }: CreateHarnessPickerProps) {
  // The SELECTED entry is user-meaningful → nuqs `?picker=` (the memo's URL
  // state design; agents read/drive it via ui:get_state / ui:dispatch).
  // Param unset = the picker grid.
  const [pickerParam, setPickerParam] = useQueryState(
    'picker',
    parseAsStringEnum<EntryStep>([...ENTRY_STEPS]),
  );
  const step: Step = pickerParam ?? 'picker';
  const setStep = (s: Step) => void setPickerParam(s === 'picker' ? null : s);
  // Default into-hive when a hive is selected (the common case from the tab).
  const [mode, setMode] = useState<CreateMode>(hiveScope ? 'into-hive' : 'standalone');
  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  // P-012 (hive-from-github-url): the GitHub-URL entry goes live behind this
  // flag; off = the legacy coming-soon stub + the old Shared-section layout.
  const githubUrlEnabled = useFlag(FLAGS.HIVE_FROM_GITHUB_URL);
  // Names the provisional owner in the ShareWizard's P-069d first-share
  // explainer. Anonymous / unresolved → undefined → the explainer's 'you'.
  const { viewer } = useViewer();

  const handleClose = () => {
    setStep('picker');
    setMode(hiveScope ? 'into-hive' : 'standalone');
    setCreatedSlug(null);
    setShareOpen(false);
    onOpenChange(false);
  };

  // The membership scope passed to a create when adding into the selected hive.
  const memberHive = mode === 'into-hive' && hiveScope ? hiveScope : undefined;

  const handleSuccess = (slug: string) => {
    // A new-hive create is a root, not a member; standalone/into-hive carry the
    // membership scope so the caller can focus the new member (P-011). Keep the
    // single-arg call for the standalone path (back-compat with existing callers).
    const createdInto = step === 'new-hive' ? undefined : memberHive;
    if (createdInto) onCreated?.(slug, { hive: createdInto });
    else onCreated?.(slug);
    setCreatedSlug(slug);
    setStep('share-offer');
  };

  const goBack = () => setStep('picker');

  // Entry 4 (harness-link) JOINS an existing shared harness — sharing
  // it again makes no sense. For Entries 1/3 (new-local, existing-local)
  // the harness is freshly local and may want to be shared.
  const showShareOffer =
    step === 'share-offer' &&
    createdSlug !== null;

  return (
    <>
      <Modal
        open={open && !shareOpen}
        onOpenChange={(v) => { if (!v) handleClose(); else onOpenChange(true); }}
        title={step === 'share-offer' && createdSlug ? 'Harness created' : 'Add a harness'}
        contentStyle={{
          width: 'min(520px, 96vw)',
          background: 'var(--bg-popover, #0d1829)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 24,
          color: 'var(--fg, #e8e8ea)',
        }}
      >
        {/* A deep-linked `?picker=share-offer` has no created slug (transient
            result state is useState) — fall back to the grid. */}
        {(step === 'picker' || (step === 'share-offer' && createdSlug === null)) && (
          <PickerStep onSelect={setStep} mode={mode} onMode={setMode} hiveScope={hiveScope} hiveLabel={hiveLabel} githubUrlEnabled={githubUrlEnabled} />
        )}
        {step === 'new-local' && <NewLocalForm onBack={goBack} onSuccess={handleSuccess} hive={memberHive} />}
        {step === 'existing-local' && <ExistingLocalForm onBack={goBack} onSuccess={handleSuccess} hive={memberHive} />}
        {step === 'new-hive' && <NewHiveForm onBack={goBack} onSuccess={handleSuccess} hiveLabel={hiveLabel} />}
        {step === 'github-url' && !githubUrlEnabled && <ComingSoonStub title="GitHub URL" onBack={goBack} />}
        {step === 'github-url' && githubUrlEnabled && (
          <EntryGithubUrlForm
            onBack={goBack}
            hiveScope={hiveScope}
            // The entry's own 3-mode fork (P-012): the picker's into-hive
            // selection carries over; otherwise the headline new-hive default.
            initialMode={mode === 'into-hive' && hiveScope ? 'into-hive' : 'new-hive'}
            onCreated={(slug, opts) => {
              // The form already showed its own success/publish summary (and a
              // hive auto-publishes per visibility) — skip the share offer.
              if (opts?.hive) onCreated?.(slug, { hive: opts.hive });
              else onCreated?.(slug);
              handleClose();
            }}
          />
        )}
        {step === 'harness-link' && (
          <EntryHarnessLinkForm
            onBack={goBack}
            onCreated={(slug) => {
              // Harness-link join — skip the share offer (already shared upstream).
              onCreated?.(slug);
              handleClose();
            }}
          />
        )}
        {showShareOffer && createdSlug && (
          <ShareOfferStep
            slug={createdSlug}
            onShare={() => setShareOpen(true)}
            onDone={handleClose}
          />
        )}
      </Modal>
      {showShareOffer && createdSlug && shareOpen && (
        <ShareWizard
          open={shareOpen}
          onClose={() => {
            setShareOpen(false);
            handleClose();
          }}
          harnessSlug={createdSlug}
          ownerLogin={viewer?.githubLogin ?? undefined}
        />
      )}
    </>
  );
}

// ── Share-offer step ───────────────────────────────────────────────────────

function ShareOfferStep({
  slug,
  onShare,
  onDone,
}: {
  slug: string;
  onShare: () => void;
  onDone: () => void;
}) {
  return (
    <div>
      <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>
        ✓ Harness created
      </h2>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--fg-dim)' }}>
        <code>{slug}</code> is registered. You can share it now so other engineers can join, or share it later from the harness top bar.
      </p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={onDone}
          style={{
            padding: '8px 14px',
            background: 'transparent',
            color: 'var(--fg-dim)',
            border: '1px solid var(--border)',
            borderRadius: 5,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Share later
        </button>
        <button
          type="button"
          onClick={onShare}
          style={{
            padding: '8px 14px',
            background: 'var(--accent, #38bdf8)',
            color: '#0a1424',
            border: 0,
            borderRadius: 5,
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Share this harness →
        </button>
      </div>
    </div>
  );
}
