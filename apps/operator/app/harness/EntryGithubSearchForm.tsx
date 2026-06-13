'use client';

/**
 * EntryGithubSearchForm — the picker's "Search GitHub" entry
 * (comb-hive-native-sharing-2026-06-11 P-009). A search-as-you-type panel over
 * the P-008 loopback proxy `GET /api/github/search-repos`, feeding the existing
 * create-from-repo flow. Pick a result OR paste a repo URL → that repo prefills
 * {@link EntryGithubUrlForm} (the 3-mode fork preserved: new-hive / into-hive /
 * standalone; runTests opt-in per hardening D-001). The create form's own
 * paste-time lookup still offers "join the existing hive" when one exists — so
 * the search → create → join path works without the P-010/P-011 result badges.
 *
 * Why raw fetch + debounce (not @papercusp/sync): this is a TRANSIENT,
 * rate-limited search against an EXTERNAL API proxy — not sync-resolver-backed
 * workspace state, and never invalidated by a write seam. Same posture as the
 * create/join POSTs in this picker family. A ~300ms debounce (P-008/P-009) +
 * AbortController cancels stale keystrokes; the proxy's own 60s LRU absorbs
 * repeats and protects the shared 30 req/min GitHub search budget.
 *
 * Anonymous box → the proxy returns `authed:false` (D-005/O-3: anonymous search
 * works at the lower budget) and we show a sign-in nudge. A drained budget
 * surfaces honestly as `429` + retryAfterSec — never silent empty results.
 *
 * Form drafts (the query box) are useState — the nuqs transient-lifecycle
 * exception, same as EntryGithubUrlForm's URL draft; the SELECTED entry lives
 * in the picker's `?picker=` nuqs param.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { EntryGithubUrlForm, parseGithubUrlClient, type FormMode } from './EntryGithubUrlForm';
import { useLexicon } from '@/lib/useLexicon';

/**
 * The result shape the P-008 proxy projects (search-repos.ts
 * GithubRepoSearchItem). Declared locally so the SPA bundle never imports the
 * route module (the harness-link-types pure-leaf rule).
 */
interface RepoResult {
  repoId: number;
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  updatedAt: string | null;
  htmlUrl: string;
  private: boolean;
  fork: boolean;
  defaultBranch: string | null;
}

type SearchPhase = 'idle' | 'url' | 'searching' | 'results' | 'empty' | 'error' | 'rate-limited';

/** ~300ms client debounce atop the proxy's 60s LRU (P-008 design / P-009). */
const DEBOUNCE_MS = 300;

export interface EntryGithubSearchFormProps {
  onBack: () => void;
  /** `opts.hive` names the hive the new member landed in (into-hive mode). */
  onCreated: (slug: string, opts?: { hive?: string }) => void;
  /** The picker's selected hive scope — enables + targets into-hive mode. */
  hiveScope?: string | null;
  /** Seed mode from the picker fork. Default new-hive — the headline flow. */
  initialMode?: FormMode;
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '8px 11px',
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg)',
  fontFamily: 'inherit',
  fontSize: 13,
  boxSizing: 'border-box',
};

const backBtnStyle: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--fg-dim)', cursor: 'pointer', padding: 0, fontSize: 13, marginBottom: 16 };
const secondaryBtn: React.CSSProperties = { padding: '7px 14px', fontSize: 13, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)', borderRadius: 5, cursor: 'pointer' };
const primaryBtn: React.CSSProperties = { padding: '7px 16px', fontSize: 13, background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--accent-ink, #051827)', borderRadius: 5, cursor: 'pointer', fontWeight: 600 };

function Hint({ children }: { children: ReactNode }) {
  return <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--fg-mute)' }}>{children}</p>;
}

function NoticeCard({ children, tone = 'info', testId }: { children: ReactNode; tone?: 'info' | 'warn'; testId?: string }) {
  const border = tone === 'warn' ? 'var(--warn, #f59e0b)' : 'var(--border)';
  const color = tone === 'warn' ? 'var(--warn, #f59e0b)' : 'var(--fg-dim)';
  return (
    <div data-testid={testId} style={{ background: 'var(--bg-2)', border: `1px solid ${border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 12.5, lineHeight: 1.5, color }}>
      {children}
    </div>
  );
}

/** Compact star count: 1234 → "1.2k". */
function fmtStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** Rough "recently active" relative label off the repo's last push. */
function relativeUpdated(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function EntryGithubSearchForm({
  onBack,
  onCreated,
  hiveScope = null,
  initialMode = 'new-hive',
}: EntryGithubSearchFormProps) {
  const t = useLexicon();
  const hiveLower = t('pot', { lower: true });

  // Transient drafts — useState per the nuqs transient-lifecycle exception.
  const [query, setQuery] = useState('');
  // The repo URL to create from — set by picking a result or short-circuiting a
  // pasted URL. While set, the create form (EntryGithubUrlForm) takes over.
  const [picked, setPicked] = useState<string | null>(null);
  const [phase, setPhase] = useState<SearchPhase>('idle');
  const [results, setResults] = useState<RepoResult[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [retryAfterSec, setRetryAfterSec] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  const urlMatch = parseGithubUrlClient(query);

  // Debounced search-as-you-type. A URL query short-circuits (no search — the
  // create flow owns URLs). AbortController cancels the stale in-flight request
  // on each keystroke / unmount; its AbortError is swallowed.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setPhase('idle');
      setResults([]);
      setActiveIdx(-1);
      return;
    }
    if (parseGithubUrlClient(q)) {
      setPhase('url');
      setResults([]);
      setActiveIdx(-1);
      return;
    }
    setPhase('searching');
    const ctrl = new AbortController();
    const tid = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/github/search-repos?q=${encodeURIComponent(q)}`, {
            signal: ctrl.signal,
          });
          const body = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            authed?: boolean;
            items?: RepoResult[];
            error?: string;
            retryAfterSec?: number;
          };
          if (ctrl.signal.aborted) return;
          // Honest rate-limit surfacing (D-002): never a silent empty result.
          if (res.status === 429) {
            setAuthed(typeof body.authed === 'boolean' ? body.authed : null);
            setRetryAfterSec(body.retryAfterSec ?? 60);
            setPhase('rate-limited');
            return;
          }
          if (!res.ok || !body.ok || !Array.isArray(body.items)) {
            setErrorMsg(
              body.error === 'invalid_query'
                ? 'GitHub couldn’t parse that query — try simpler search terms.'
                : 'GitHub search is unavailable right now. Try again in a moment.',
            );
            setPhase('error');
            return;
          }
          setAuthed(body.authed === true);
          setResults(body.items);
          setActiveIdx(body.items.length ? 0 : -1);
          setPhase(body.items.length ? 'results' : 'empty');
        } catch (e) {
          if ((e as Error).name === 'AbortError') return;
          setErrorMsg('Network error reaching GitHub search.');
          setPhase('error');
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(tid);
      ctrl.abort();
    };
  }, [query]);

  // Keep the keyboard-selected row in view (guarded — jsdom has no real
  // scrollIntoView).
  useEffect(() => {
    const row = activeRowRef.current;
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  // A repo was picked / a URL short-circuited → hand off to the create form
  // prefilled. Back from there returns to this search list (setPicked(null)).
  if (picked) {
    return (
      <EntryGithubUrlForm
        initialUrl={picked}
        onBack={() => setPicked(null)}
        onCreated={onCreated}
        hiveScope={hiveScope}
        initialMode={initialMode}
      />
    );
  }

  const pickResult = (r: RepoResult) => setPicked(r.htmlUrl);
  const continueWithUrl = () => {
    if (urlMatch) setPicked(query.trim());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (phase === 'url') {
      if (e.key === 'Enter') {
        e.preventDefault();
        continueWithUrl();
      }
      return;
    }
    if (phase !== 'results' || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[activeIdx];
      if (r) pickResult(r);
    }
  };

  const signInNudge = authed === false && (
    <NoticeCard testId="gh-search-signin-nudge">
      You’re searching anonymously (a lower rate limit). Run <code>gh auth login</code> in your terminal
      for private repos and a higher limit, then search again.
    </NoticeCard>
  );

  return (
    <div>
      <button type="button" onClick={onBack} style={backBtnStyle}>
        ← Back
      </button>
      <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Search GitHub</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
        Find any repository on GitHub and create or join a {hiveLower} from it. Paste a repo URL to skip
        straight to create.
      </p>

      <label style={{ display: 'block', marginBottom: 12 }}>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-dim)', marginBottom: 4, fontWeight: 500 }}>
          Search repositories
        </span>
        <input
          type="text"
          role="searchbox"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="owner/repo, keywords, or a GitHub URL…"
          style={inputStyle}
          autoFocus
          aria-label="Search GitHub repositories"
        />
        {phase === 'idle' && <Hint>Type to search all of GitHub — full name, description, stars, language.</Hint>}
      </label>

      {/* URL short-circuit: skip search, go straight to the create flow. */}
      {phase === 'url' && urlMatch && (
        <div style={{ background: 'var(--bg-2)', border: '1px solid var(--accent)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
          <p style={{ margin: '0 0 8px', fontSize: 12.5, color: 'var(--fg-dim)' }}>
            That’s a repository URL — <strong style={{ color: 'var(--fg)' }}>{urlMatch.owner}/{urlMatch.repo}</strong>.
          </p>
          <button type="button" data-testid="gh-search-url-continue" onClick={continueWithUrl} style={primaryBtn}>
            Continue with {urlMatch.owner}/{urlMatch.repo} →
          </button>
        </div>
      )}

      {phase === 'searching' && (
        <p style={{ margin: '8px 0', fontSize: 13, color: 'var(--fg-dim)' }}>Searching GitHub…</p>
      )}

      {phase === 'rate-limited' && (
        <NoticeCard tone="warn">
          <div role="alert">
            GitHub search is rate-limited — retry in {retryAfterSec ?? 60}s.
          </div>
          {authed === false && (
            <Hint>Sign in (`gh auth login`) for a higher search budget.</Hint>
          )}
        </NoticeCard>
      )}

      {phase === 'error' && (
        <NoticeCard tone="warn">
          <div role="alert">{errorMsg}</div>
        </NoticeCard>
      )}

      {phase === 'empty' && (
        <p style={{ margin: '8px 0', fontSize: 13, color: 'var(--fg-dim)' }}>
          No repositories matched “{query.trim()}”.
        </p>
      )}

      {phase === 'results' && (
        <>
          {signInNudge}
          <div role="listbox" aria-label="GitHub search results" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            {results.map((r, i) => {
              const active = i === activeIdx;
              const updated = relativeUpdated(r.updatedAt);
              return (
                <button
                  key={r.repoId || r.fullName}
                  ref={active ? activeRowRef : null}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-testid="gh-search-result"
                  onClick={() => pickResult(r)}
                  onMouseEnter={() => setActiveIdx(i)}
                  style={{
                    textAlign: 'left',
                    padding: '9px 11px',
                    background: active ? 'var(--bg-3, var(--bg-2))' : 'var(--bg-2)',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    borderRadius: 7,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <strong style={{ fontSize: 13, color: 'var(--fg)' }}>{r.fullName}</strong>
                    {r.private && (
                      <span style={{ fontSize: 10, color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px' }}>private</span>
                    )}
                    {r.fork && (
                      <span style={{ fontSize: 10, color: 'var(--fg-mute)', border: '1px solid var(--border)', borderRadius: 3, padding: '0 4px' }}>fork</span>
                    )}
                  </span>
                  {r.description && (
                    <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-mute)', lineHeight: 1.4, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.description}
                    </span>
                  )}
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--fg-dim)', marginTop: 4 }}>
                    ★ {fmtStars(r.stars)}
                    {r.language ? ` · ${r.language}` : ''}
                    {updated ? ` · updated ${updated}` : ''}
                  </span>
                </button>
              );
            })}
          </div>
          <Hint>↑↓ to navigate · Enter to pick · or click a result.</Hint>
        </>
      )}
    </div>
  );
}
