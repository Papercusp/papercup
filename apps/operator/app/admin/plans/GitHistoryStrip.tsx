'use client';

/**
 * Git history strip + diff modal (P-303).
 *
 * Compact collapsed strip below the editor with the last ~5 commits
 * touching the plan file. Clicking a commit opens a modal showing the
 * unified diff (`git diff <hash>^!`). The strip uses nuqs for the
 * expanded state and the open-diff hash, so links are shareable.
 *
 * Data flow: a UI-only route handler (D-303 alternative) runs
 * `git log --follow` and `git diff` server-side. No plans:* tool yet
 * — Q3 promotes this to a plans:history endpoint later.
 */

import { parseAsBoolean, parseAsString, useQueryState } from 'nuqs';
import { useEffect, useMemo, useState } from 'react';
import { Diff, Hunk, parseDiff, type FileData } from 'react-diff-view';
import { Modal } from '@/app/harness/Modal';
import { fetchPlanDiff, usePlanHistory } from './plans-api';

interface Props {
  slug: string;
  archived: boolean;
}

const COLLAPSED_COUNT = 5;

export default function GitHistoryStrip({ slug, archived }: Props) {
  const { data, loading, error, refresh } = usePlanHistory(slug, archived);
  const [expanded, setExpanded] = useQueryState(
    'gitOpen',
    parseAsBoolean.withDefault(false),
  );
  const [diffHash, setDiffHash] = useQueryState('gitDiff', parseAsString.withDefault(''));

  const commits = data ?? [];
  const visible = expanded ? commits : commits.slice(0, COLLAPSED_COUNT);

  // `gitDiff` is a global nuqs key — navigating between plans can leave
  // a hash from the previous plan in the URL. Once this plan's history
  // has loaded, drop a diff hash that isn't one of its commits so the
  // modal never tries to fetch a foreign (or stale) diff.
  useEffect(() => {
    if (diffHash && commits.length && !commits.some((c) => c.hash === diffHash)) {
      setDiffHash('');
    }
  }, [diffHash, commits, setDiffHash]);

  if (error) {
    return (
      <div className="pc-git-strip pc-git-strip--error">
        <span>Git history: {error}</span>
        <button type="button" className="pc-git-strip__retry" onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  if (loading && !commits.length) {
    return <div className="pc-git-strip pc-git-strip--loading">Loading git history…</div>;
  }
  if (!commits.length) {
    return <div className="pc-git-strip pc-git-strip--empty">No git history for this plan.</div>;
  }

  return (
    <div className="pc-git-strip" aria-label="Git history">
      <header className="pc-git-strip__head">
        <span className="pc-git-strip__kicker">History</span>
        <span className="pc-git-strip__count">{commits.length}</span>
        {commits.length > COLLAPSED_COUNT ? (
          <button
            type="button"
            className="pc-git-strip__toggle"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? `Show last ${COLLAPSED_COUNT}` : `Show all ${commits.length}`}
          </button>
        ) : null}
      </header>
      <ul className="pc-git-strip__list">
        {visible.map((c) => (
          <li key={c.hash}>
            <button
              type="button"
              className="pc-git-commit"
              onClick={() => setDiffHash(c.hash)}
              title={c.subject}
            >
              <span className="pc-git-commit__hash">{c.hash.slice(0, 8)}</span>
              <span className="pc-git-commit__date">{formatDate(c.date)}</span>
              <span className="pc-git-commit__author">{c.author}</span>
              <span className="pc-git-commit__subject">{c.subject}</span>
            </button>
          </li>
        ))}
      </ul>
      <GitDiffModal
        slug={slug}
        archived={archived}
        hash={diffHash || null}
        onClose={() => setDiffHash('')}
      />
    </div>
  );
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  const d = new Date(t);
  const ageMs = Date.now() - t;
  const day = 86_400_000;
  if (ageMs < day) {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }
  if (ageMs < day * 365) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { year: '2-digit', month: 'short' });
}

function GitDiffModal({
  slug,
  archived,
  hash,
  onClose,
}: {
  slug: string;
  archived: boolean;
  hash: string | null;
  onClose: () => void;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!hash) {
      setDiff(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPlanDiff(slug, archived, hash)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slug, archived, hash]);

  const { files, parseError } = useMemo(() => {
    if (diff === null) {
      return {
        files: [] as FileData[],
        parseError: null as string | null,
      };
    }
    try {
      return {
        files: parseDiff(diff, { nearbySequences: 'zip' }),
        parseError: null,
      };
    } catch (e) {
      return {
        files: [] as FileData[],
        parseError: e instanceof Error ? e.message : String(e),
      };
    }
  }, [diff]);

  return (
    <Modal
      open={!!hash}
      onOpenChange={(o) => !o && onClose()}
      title={hash ? `Diff ${hash.slice(0, 8)}` : 'Diff'}
      srOnlyTitle
      contentClassName="pc-git-diff"
    >
      <header className="pc-git-diff__head">
        <h3>Diff <code>{hash?.slice(0, 12)}</code></h3>
        <button type="button" className="pc-git-diff__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {loading ? <div className="pc-git-diff__loading">Loading…</div> : null}
      {error ? <div className="pc-git-diff__error">{error}</div> : null}
      {diff !== null && !loading && !error ? (
        <div className="pc-git-diff__body">
          <GitDiffBody diff={diff} files={files} parseError={parseError} />
        </div>
      ) : null}
    </Modal>
  );
}

// Body of the diff modal: parsed per-file cards when react-diff-view
// understood the patch, otherwise the raw patch text as a fallback.
function GitDiffBody({
  diff,
  files,
  parseError,
}: {
  diff: string;
  files: FileData[];
  parseError: string | null;
}) {
  const parseWarning = parseError ? (
    <div className="pc-git-diff__parse-warning">
      Couldn’t parse the diff into structured hunks. Showing raw patch below.
    </div>
  ) : null;

  if (files.length) {
    return (
      <>
        {parseWarning}
        {files.map((file, index) => (
          <DiffFileCard
            key={`${file.oldRevision}-${file.newRevision}-${file.newPath ?? file.oldPath}-${index}`}
            file={file}
          />
        ))}
      </>
    );
  }

  if (diff.trim()) {
    return (
      <>
        {parseWarning}
        <pre className="pc-git-diff__raw">{diff}</pre>
      </>
    );
  }

  return <div className="pc-git-diff__empty">No diff output for this commit.</div>;
}

function DiffFileCard({ file }: { file: FileData }) {
  const { additions, deletions } = countChanges(file);
  return (
    <section className="pc-git-diff-file">
      <header className="pc-git-diff-file__head">
        <div className="pc-git-diff-file__path">
          <code>{formatFilePath(file.oldPath, file.newPath)}</code>
        </div>
        <div className="pc-git-diff-file__meta">
          <span className={`pc-git-diff-file__type pc-git-diff-file__type--${file.type}`}>
            {file.type}
          </span>
          <span className="pc-git-diff-file__stat pc-git-diff-file__stat--add">+{additions}</span>
          <span className="pc-git-diff-file__stat pc-git-diff-file__stat--del">-{deletions}</span>
        </div>
      </header>
      <div className="pc-git-diff-file__table">
        <Diff
          viewType="unified"
          diffType={file.type}
          hunks={file.hunks}
          className="pc-git-diff-table"
          hunkClassName="pc-git-diff-hunk"
          lineClassName="pc-git-diff-line"
          gutterClassName="pc-git-diff-gutter"
          codeClassName="pc-git-diff-code"
          // react-diff-view ignores `lineClassName` unless `generateLineClassName`
          // forwards `defaultGenerate()` — this keeps `pc-git-diff-line` on each row.
          generateLineClassName={({ defaultGenerate }) => defaultGenerate()}
        >
          {(hunks) =>
            hunks.map((hunk, hunkIndex) => (
              <Hunk
                key={`${file.newPath ?? file.oldPath}-${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`}
                hunk={hunk}
              />
            ))
          }
        </Diff>
      </div>
    </section>
  );
}

function formatFilePath(oldPath: string, newPath: string): string {
  if (!oldPath) return newPath;
  if (!newPath || oldPath === newPath) return oldPath;
  return `${oldPath} → ${newPath}`;
}

function countChanges(file: FileData): { additions: number; deletions: number } {
  return file.hunks.reduce(
    (totals, hunk) => {
      for (const change of hunk.changes) {
        if (change.type === 'insert') totals.additions += 1;
        else if (change.type === 'delete') totals.deletions += 1;
      }
      return totals;
    },
    { additions: 0, deletions: 0 },
  );
}
