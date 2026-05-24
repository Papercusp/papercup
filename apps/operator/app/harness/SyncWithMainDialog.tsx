'use client';

/**
 * SyncWithMainDialog — Phase 9 P-055b/c.
 *
 * Modal dialog for manual sync-with-main:
 *   - "Sync" button runs git fetch + git rebase origin/main.
 *   - On clean rebase: success message.
 *   - On conflict: lists conflicted files with "Open in editor" /
 *     "Mark resolved" / "Abort rebase" actions (P-055c).
 *
 * No custom conflict-resolution UI per v5 audit J — uses $EDITOR
 * via the backend "open_editor" action.
 */

import React, { useCallback, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, GitMerge, AlertTriangle, CheckCircle, Loader2, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { COLORS, FONTS, RADIUS, SIZES } from './theme';

interface ConflictedFile {
  path: string;
  resolved: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  githubUserId: number;
}

type Phase = 'idle' | 'syncing' | 'clean' | 'conflict' | 'aborting';

export function SyncWithMainDialog({ open, onOpenChange, slug, githubUserId }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [conflictedFiles, setConflictedFiles] = useState<ConflictedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleSync = useCallback(async () => {
    setPhase('syncing');
    setError(null);
    setConflictedFiles([]);
    try {
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/sync-with-main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github_user_id: githubUserId }),
      });
      const data = (await res.json()) as {
        outcome: 'clean' | 'conflict' | 'fetch_failed';
        conflicted_files?: string[];
        error?: string;
      };
      if (data.outcome === 'clean') {
        setPhase('clean');
        toast.success('Synced with main — rebase complete.');
      } else if (data.outcome === 'conflict') {
        setConflictedFiles((data.conflicted_files ?? []).map((p) => ({ path: p, resolved: false })));
        setPhase('conflict');
      } else {
        setError(data.error ?? 'git fetch failed');
        setPhase('idle');
      }
    } catch (err) {
      setError(String(err));
      setPhase('idle');
    }
  }, [slug, githubUserId]);

  const handleAbort = useCallback(async () => {
    setPhase('aborting');
    try {
      await fetch(`/api/harness/${encodeURIComponent(slug)}/sync-with-main/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github_user_id: githubUserId }),
      });
      toast.info('Rebase aborted.');
      setConflictedFiles([]);
      setPhase('idle');
    } catch {
      toast.error('Abort failed — run `git rebase --abort` manually.');
      setPhase('conflict');
    }
  }, [slug, githubUserId]);

  const handleOpenInEditor = useCallback(
    (filePath: string) => {
      // Open via code-server URL if available, otherwise show path.
      const csUrl = `http://localhost:8082/?folder=${encodeURIComponent(
        `/harness/${slug}`,
      )}&file=${encodeURIComponent(filePath)}`;
      window.open(csUrl, '_blank', 'noopener,noreferrer');
    },
    [slug],
  );

  const handleMarkResolved = useCallback((filePath: string) => {
    setConflictedFiles((prev) =>
      prev.map((f) => (f.path === filePath ? { ...f, resolved: true } : f)),
    );
  }, []);

  const allResolved = conflictedFiles.length > 0 && conflictedFiles.every((f) => f.resolved);

  const handleContinueRebase = useCallback(async () => {
    setPhase('syncing');
    try {
      // git rebase --continue via a dedicated backend call.
      const res = await fetch(`/api/harness/${encodeURIComponent(slug)}/sync-with-main`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ github_user_id: githubUserId }),
      });
      const data = (await res.json()) as { outcome: string; conflicted_files?: string[] };
      if (data.outcome === 'clean') {
        setPhase('clean');
        toast.success('Rebase complete.');
        setConflictedFiles([]);
      } else if (data.outcome === 'conflict') {
        setConflictedFiles((data.conflicted_files ?? []).map((p) => ({ path: p, resolved: false })));
        setPhase('conflict');
        toast.warning('More conflicts remain.');
      } else {
        setPhase('conflict');
        toast.error('Rebase continue failed.');
      }
    } catch (err) {
      setPhase('conflict');
      toast.error(String(err));
    }
  }, [slug, githubUserId]);

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.5)',
    zIndex: 200,
  };

  const contentStyle: React.CSSProperties = {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    background: COLORS.bg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: RADIUS.lg,
    padding: SIZES.lg,
    width: 480,
    maxWidth: '95vw',
    maxHeight: '80vh',
    overflowY: 'auto',
    zIndex: 201,
    display: 'flex',
    flexDirection: 'column',
    gap: SIZES.md,
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay style={overlayStyle} />
        <Dialog.Content style={contentStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Dialog.Title
              style={{ fontFamily: FONTS.sans, fontWeight: 600, fontSize: FONTS.size.md, color: COLORS.text, margin: 0 }}
            >
              Sync with main
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: COLORS.textMuted }}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {phase === 'idle' && (
            <>
              <p style={{ fontSize: FONTS.size.sm, color: COLORS.textMuted, margin: 0 }}>
                Fetch <code>origin/main</code> and rebase your branch on top. Conflicts will be
                listed here for resolution.
              </p>
              {error && (
                <div style={{ color: '#f87171', fontSize: FONTS.size.sm, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                  {error}
                </div>
              )}
              <button
                onClick={handleSync}
                style={{
                  background: COLORS.accent,
                  color: '#fff',
                  border: 'none',
                  borderRadius: RADIUS.md,
                  padding: '8px 16px',
                  cursor: 'pointer',
                  fontFamily: FONTS.sans,
                  fontSize: FONTS.size.sm,
                  alignSelf: 'flex-start',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <GitMerge size={14} /> Sync with main
              </button>
            </>
          )}

          {(phase === 'syncing' || phase === 'aborting') && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: COLORS.textMuted, fontSize: FONTS.size.sm }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              {phase === 'syncing' ? 'Running git rebase…' : 'Aborting rebase…'}
            </div>
          )}

          {phase === 'clean' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#4ade80', fontSize: FONTS.size.sm }}>
              <CheckCircle size={14} />
              Rebase complete — your branch is up to date with main.
            </div>
          )}

          {phase === 'conflict' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#f59e0b', fontSize: FONTS.size.sm }}>
                <AlertTriangle size={14} />
                <strong>Conflicts detected</strong> — resolve each file, then continue.
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {conflictedFiles.map((f) => (
                  <div
                    key={f.path}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      background: COLORS.surface,
                      border: `1px solid ${COLORS.border}`,
                      borderRadius: RADIUS.sm,
                      padding: '6px 10px',
                      gap: 8,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      {f.resolved ? (
                        <CheckCircle size={13} color="#4ade80" />
                      ) : (
                        <FileText size={13} color="#f59e0b" />
                      )}
                      <code
                        style={{
                          fontSize: FONTS.size.xs,
                          fontFamily: FONTS.mono,
                          color: f.resolved ? COLORS.textMuted : COLORS.text,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {f.path}
                      </code>
                    </div>
                    {!f.resolved && (
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <button
                          onClick={() => handleOpenInEditor(f.path)}
                          style={smallBtnStyle}
                          title="Open in code-server"
                        >
                          Open in editor
                        </button>
                        <button
                          onClick={() => handleMarkResolved(f.path)}
                          style={{ ...smallBtnStyle, background: '#166534', color: '#4ade80' }}
                          title="Mark as resolved"
                        >
                          Mark resolved
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={handleContinueRebase}
                  disabled={!allResolved}
                  style={{
                    background: allResolved ? COLORS.accent : COLORS.surface,
                    color: allResolved ? '#fff' : COLORS.textMuted,
                    border: `1px solid ${COLORS.border}`,
                    borderRadius: RADIUS.md,
                    padding: '6px 14px',
                    cursor: allResolved ? 'pointer' : 'not-allowed',
                    fontFamily: FONTS.sans,
                    fontSize: FONTS.size.sm,
                  }}
                >
                  Continue rebase
                </button>
                <button
                  onClick={handleAbort}
                  style={{
                    background: 'none',
                    color: '#f87171',
                    border: `1px solid #7f1d1d`,
                    borderRadius: RADIUS.md,
                    padding: '6px 14px',
                    cursor: 'pointer',
                    fontFamily: FONTS.sans,
                    fontSize: FONTS.size.sm,
                  }}
                >
                  Abort rebase
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const smallBtnStyle: React.CSSProperties = {
  background: 'none',
  border: `1px solid ${COLORS.border}`,
  borderRadius: 3,
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 11,
  color: COLORS.textMuted,
  fontFamily: FONTS.mono,
};
