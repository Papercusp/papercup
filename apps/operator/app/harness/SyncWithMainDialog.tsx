'use client';

/**
 * SyncWithMainDialog — Phase 9 P-055b/c.
 *
 * Drop-down panel with a "Sync with main" button. On conflict, shows
 * the conflicted file list with "open in editor" / "mark resolved" /
 * "abort rebase" per v5 §16.2 (no custom conflict UI, $EDITOR fallback).
 */

import React, { useCallback, useState } from 'react';
import { AlertTriangle, CheckCircle, GitMerge, Loader2, X } from 'lucide-react';
import { COLORS, FONTS, RADIUS } from './theme';

interface ConflictResult {
  outcome: 'conflict';
  conflicted_files: string[];
  error?: string;
}

interface CleanResult {
  outcome: 'clean';
}

interface FetchFailedResult {
  outcome: 'fetch_failed';
  error?: string;
}

type SyncResult = CleanResult | ConflictResult | FetchFailedResult;

interface Props {
  harnessSlug: string;
  githubUserId: number;
  onClose: () => void;
}

async function postSyncWithMain(harnessSlug: string, githubUserId: number): Promise<SyncResult> {
  const r = await fetch(
    `/api/harness/${encodeURIComponent(harnessSlug)}/sync-with-main`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ github_user_id: githubUserId }),
    },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<SyncResult>;
}

async function postAbortRebase(harnessSlug: string, githubUserId: number): Promise<void> {
  await fetch(
    `/api/harness/${encodeURIComponent(harnessSlug)}/sync-with-main/abort`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ github_user_id: githubUserId }),
    },
  ).catch(() => {});
}

async function openFileInEditor(harnessSlug: string, filePath: string): Promise<void> {
  // Ask the sidecar to open the file in $EDITOR / git core.editor.
  await fetch(
    `/api/harness/${encodeURIComponent(harnessSlug)}/open-in-editor`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    },
  ).catch(() => {});
}

export function SyncWithMainDialog({ harnessSlug, githubUserId, onClose }: Props) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [resolvedFiles, setResolvedFiles] = useState<Set<string>>(new Set());

  const handleSync = useCallback(async () => {
    setRunning(true);
    setResult(null);
    setFetchError(null);
    setResolvedFiles(new Set());
    try {
      const r = await postSyncWithMain(harnessSlug, githubUserId);
      setResult(r);
    } catch (e) {
      setFetchError(String(e));
    } finally {
      setRunning(false);
    }
  }, [harnessSlug, githubUserId]);

  const handleAbort = useCallback(async () => {
    await postAbortRebase(harnessSlug, githubUserId);
    setResult(null);
  }, [harnessSlug, githubUserId]);

  const markResolved = useCallback((f: string) => {
    setResolvedFiles((prev) => new Set([...prev, f]));
  }, []);

  const conflictedFiles =
    result?.outcome === 'conflict' ? result.conflicted_files : [];
  const remainingConflicts = conflictedFiles.filter((f) => !resolvedFiles.has(f));

  const showInitial = !running && !result && !fetchError;

  return (
    <div
      style={{
        position: 'absolute',
        top: 'calc(100% + 4px)',
        left: 0,
        zIndex: 200,
        background: COLORS.surfaceRaised,
        border: `1px solid ${COLORS.border}`,
        borderRadius: RADIUS.lg,
        padding: 16,
        minWidth: 280,
        maxWidth: 380,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        fontFamily: FONTS.ui,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <GitMerge size={14} color={COLORS.accent} />
          <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.text }}>
            Sync with main
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: COLORS.textMuted,
            padding: 2,
          }}
          aria-label="Close"
        >
          <X size={13} />
        </button>
      </div>

      {/* Initial state */}
      {showInitial && (
        <>
          <p style={{ fontSize: 12, color: COLORS.textMuted, marginBottom: 12 }}>
            Fetches{' '}
            <code style={{ fontFamily: 'ui-monospace,monospace', color: COLORS.text }}>
              origin/main
            </code>{' '}
            and rebases your branch onto it.
          </p>
          <button onClick={() => void handleSync()} style={primaryBtnStyle}>
            Sync now
          </button>
        </>
      )}

      {/* Running */}
      {running && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: COLORS.textMuted,
            fontSize: 12,
          }}
        >
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          Fetching + rebasing…
        </div>
      )}

      {/* Fetch/network error */}
      {fetchError && (
        <>
          <div style={{ color: COLORS.dangerText, fontSize: 12, marginBottom: 8 }}>
            Failed: {fetchError}
          </div>
          <button onClick={() => setFetchError(null)} style={backBtnStyle}>
            ← back
          </button>
        </>
      )}

      {/* Clean */}
      {result?.outcome === 'clean' && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: COLORS.successText,
              fontSize: 12,
              marginBottom: 8,
            }}
          >
            <CheckCircle size={14} />
            Up to date — rebase applied cleanly.
          </div>
          <button onClick={() => setResult(null)} style={backBtnStyle}>
            ← back
          </button>
        </>
      )}

      {/* Fetch failed */}
      {result?.outcome === 'fetch_failed' && (
        <>
          <div style={{ color: COLORS.dangerText, fontSize: 12, marginBottom: 8 }}>
            <AlertTriangle size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Could not reach origin: {result.error ?? 'network error'}
          </div>
          <button onClick={() => setResult(null)} style={backBtnStyle}>
            ← back
          </button>
        </>
      )}

      {/* Conflict — P-055c */}
      {result?.outcome === 'conflict' && (
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: COLORS.dangerText,
              marginBottom: 10,
              fontSize: 12,
            }}
          >
            <AlertTriangle size={13} />
            <span>
              Merge conflicts in {conflictedFiles.length} file
              {conflictedFiles.length !== 1 ? 's' : ''}.
            </span>
          </div>
          <p style={{ fontSize: 11, color: COLORS.textMuted, marginBottom: 10 }}>
            Open each file in your editor, resolve the markers, mark resolved,
            then try sync again — or abort to undo.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
            {conflictedFiles.map((f) => {
              const resolved = resolvedFiles.has(f);
              return (
                <div
                  key={f}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '4px 8px',
                    background: COLORS.surface,
                    borderRadius: RADIUS.sm,
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontFamily: 'ui-monospace,monospace',
                      color: resolved ? COLORS.textMuted : COLORS.text,
                      textDecoration: resolved ? 'line-through' : 'none',
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={f}
                  >
                    {f}
                  </span>
                  {!resolved ? (
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button
                        onClick={() => void openFileInEditor(harnessSlug, f)}
                        style={chipStyle}
                        title="Open in editor"
                      >
                        open
                      </button>
                      <button
                        onClick={() => markResolved(f)}
                        style={chipStyle}
                        title="Mark resolved"
                      >
                        ✓
                      </button>
                    </div>
                  ) : (
                    <CheckCircle size={11} color={COLORS.successText} style={{ flexShrink: 0 }} />
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            {remainingConflicts.length === 0 && conflictedFiles.length > 0 && (
              <button onClick={() => void handleSync()} style={primaryBtnStyle}>
                Try sync again
              </button>
            )}
            <button
              onClick={() => void handleAbort()}
              style={{
                ...primaryBtnStyle,
                background: COLORS.dangerBg,
                color: COLORS.dangerText,
              }}
            >
              Abort rebase
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const primaryBtnStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 12px',
  background: COLORS.accent,
  color: '#fff',
  border: 'none',
  borderRadius: RADIUS.md,
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: FONTS.ui,
};

const backBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: 11,
  color: COLORS.textMuted,
  fontFamily: FONTS.ui,
  padding: 0,
};

const chipStyle: React.CSSProperties = {
  fontSize: 10,
  padding: '1px 6px',
  background: COLORS.surfaceHover,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 3,
  cursor: 'pointer',
  color: COLORS.textMuted,
  fontFamily: 'inherit',
};
