'use client';

/**
 * CreateHarnessPicker — modal picker for adding a new harness to the workspace.
 *
 * Implements Phase 1a P-012 (papercusp-dogfood-phase1a-workspace-ui-shell-2026-05-24):
 *   P-012a  4-entry picker renders with Phase 1b placeholders
 *   P-012b  Entry 1 (New local directory) happy path
 *   P-012c  Entry 3 (Existing local repo) happy path
 *   P-012d  Per-error-code error messages
 *   P-012e  Phase 1b placeholder entries link out
 *
 * Entry 2 (GitHub URL) and Entry 4 (Harness link) are Phase 1b stubs.
 */

import { useState, useRef, type FormEvent, type ReactNode } from 'react';
import { Modal } from './Modal';
import { toast } from 'sonner';

// ── Types ──────────────────────────────────────────────────────────────────

type Step =
  | 'picker'
  | 'new-local'
  | 'existing-local'
  | 'github-url-stub'
  | 'harness-link-stub';

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

function NewLocalForm({ onBack, onSuccess }: { onBack: () => void; onSuccess: (slug: string) => void }) {
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
        body: JSON.stringify({ slug, parentDir, folderName }),
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

function ExistingLocalForm({ onBack, onSuccess }: { onBack: () => void; onSuccess: (slug: string) => void }) {
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
        body: JSON.stringify({ slug, path }),
      });
      if (!res.ok) {
        const body: ApiError = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setError(friendlyError(body.code, body.error));
        setBusy(false);
        return;
      }
      const data: CreateResult = await res.json();
      toast.success(`Harness '${data.project.slug}' added from ${data.project.path}`);
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
      <Label>
        <FieldLabel>Harness slug</FieldLabel>
        <input ref={slugRef} type="text" placeholder="my-project" style={inputStyle} autoFocus pattern="[a-z0-9][a-z0-9-]*" title="lowercase alphanumeric, hyphens OK" />
        <HintText>Lowercase, hyphens OK.</HintText>
      </Label>
      <Label>
        <FieldLabel>Path to repo</FieldLabel>
        <input ref={pathRef} type="text" placeholder="/home/user/projects/my-project" style={inputStyle} />
        <HintText>Absolute path to an existing git repository or project directory.</HintText>
      </Label>
      <SubmitRow busy={busy} label="Add harness" onBack={onBack} />
    </form>
  );
}

// ── Phase 1b placeholder ───────────────────────────────────────────────────

function Phase1bStub({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div>
      <BackBtn onBack={onBack} />
      <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>{title}</h2>
      <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 20, textAlign: 'center' }}>
        <span style={{ fontSize: 28, display: 'block', marginBottom: 10 }}>🚧</span>
        <p style={{ margin: '0 0 8px', fontWeight: 600, fontSize: 14 }}>Available in Phase 1b</p>
        <p style={{ margin: '0 0 16px', color: 'var(--fg-dim)', fontSize: 13, lineHeight: 1.5 }}>
          This entry type requires GitHub authentication and repository cloning, which ships in Phase 1b.
        </p>
        <a
          href="/internal/docs/agent-insights"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'var(--accent)', fontSize: 13, textDecoration: 'underline' }}
        >
          View Phase 1b plan →
        </a>
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

const ENTRIES: {
  id: Step;
  label: string;
  description: string;
  icon: string;
  phase1b?: boolean;
}[] = [
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
  {
    id: 'github-url-stub',
    label: 'GitHub URL',
    description: 'Clone a GitHub repository and register it. Requires GitHub auth.',
    icon: '🐙',
    phase1b: true,
  },
  {
    id: 'harness-link-stub',
    label: 'Harness link',
    description: 'Link to a shared harness from another Papercusp workspace.',
    icon: '🔗',
    phase1b: true,
  },
];

function PickerStep({ onSelect }: { onSelect: (step: Step) => void }) {
  return (
    <div>
      <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Add a harness</h2>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--fg-dim)' }}>
        Choose how to add a new harness to this workspace.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {ENTRIES.map((entry) => (
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
            <strong style={{ fontSize: 13, display: 'block', marginBottom: 4, color: entry.phase1b ? 'var(--fg-mute)' : 'var(--fg)' }}>
              {entry.label}
            </strong>
            <span style={{ fontSize: 12, color: 'var(--fg-mute)', lineHeight: 1.4, display: 'block' }}>
              {entry.description}
            </span>
            {entry.phase1b && (
              <span
                aria-label="Phase 1b"
                style={{
                  position: 'absolute',
                  top: 8,
                  right: 8,
                  background: 'var(--bg-3, #1a2540)',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 600,
                  color: 'var(--fg-mute)',
                  padding: '2px 5px',
                  letterSpacing: '0.03em',
                }}
              >
                Phase 1b
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Public component ───────────────────────────────────────────────────────

interface CreateHarnessPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a harness is successfully created/added. */
  onCreated?: (slug: string) => void;
}

export function CreateHarnessPicker({ open, onOpenChange, onCreated }: CreateHarnessPickerProps) {
  const [step, setStep] = useState<Step>('picker');

  const handleClose = () => {
    setStep('picker');
    onOpenChange(false);
  };

  const handleSuccess = (slug: string) => {
    onCreated?.(slug);
    handleClose();
  };

  const goBack = () => setStep('picker');

  return (
    <Modal
      open={open}
      onOpenChange={(v) => { if (!v) handleClose(); else onOpenChange(true); }}
      title="Add a harness"
      contentStyle={{
        width: 'min(520px, 96vw)',
        background: 'var(--bg-popover, #0d1829)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 24,
        color: 'var(--fg, #e8e8ea)',
      }}
    >
      {step === 'picker' && <PickerStep onSelect={setStep} />}
      {step === 'new-local' && <NewLocalForm onBack={goBack} onSuccess={handleSuccess} />}
      {step === 'existing-local' && <ExistingLocalForm onBack={goBack} onSuccess={handleSuccess} />}
      {step === 'github-url-stub' && <Phase1bStub title="GitHub URL" onBack={goBack} />}
      {step === 'harness-link-stub' && <Phase1bStub title="Harness link" onBack={goBack} />}
    </Modal>
  );
}
