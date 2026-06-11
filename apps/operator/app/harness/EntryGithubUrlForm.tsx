'use client';

/**
 * EntryGithubUrlForm — the picker's GitHub-URL entry, reborn at Hive level
 * (hive-from-github-url-2026-06-11 P-011). Adopts the Entry-2 form design from
 * dogfood-design-memo-create-harness-picker-ux-2026-05-24 (focused form, inline
 * progress strip, errorCodeToCopy mapping) re-targeted at hives.
 *
 * Three modes (the P-012 creation fork):
 *   new-hive   (the headline, default) → POST /api/harness/hives/from-repo:
 *              clone → blueprint detect → hive home + member → visibility-gated
 *              auto-publish (D-002/D-003).
 *   into-hive  same route with `intoHive` — adds the repo as a member of the
 *              selected hive (no new home/identity).
 *   standalone (D-007) → POST /api/harness/projects githubUrl path: clone +
 *              register + blueprint; no hive, no publish.
 *
 * A paste-time lookup hit returns `existing` — a JOIN OFFER with zero side
 * effects. The form swaps to a confirm card whose Join drives the EXISTING
 * join path (POST /api/harness/join-link per member link — the
 * WorkbenchHiveDirectoryPanel mechanics, with the per-repo slug derived from
 * each link's github coords). No member links → "exists but isn't joinable
 * yet" + Create-anyway (re-submit with force:true → duplicateOf-flagged).
 *
 * The backend response is ONE-SHOT, so the progress strip animates only the
 * CURRENT step (spinner advancing on a rough schedule); done/failed states are
 * settled exclusively from the real response — never a fabricated checkmark.
 *
 * Form drafts are useState (the nuqs transient-lifecycle exception); the
 * SELECTED entry lives in the picker's `?picker=` nuqs param.
 */

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
// Pure parser leaf — SPA-bundle-safe (same import EntryHarnessLinkForm uses).
import { parseHarnessLink } from '@papercusp/operator-core/lib/harness/harness-link-types';
import { useLexicon } from '@/lib/useLexicon';

// ── Client-side GitHub URL validation ──────────────────────────────────────
// Mirrors clone-github.ts parseGithubUrl (the server-side source of truth).
// Duplicated as a pure client regex so the SPA bundle never pulls the
// node:child_process-importing clone module (the EntryHarnessLinkForm rule).

const GITHUB_HTTPS_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?\/?$/;
const GITHUB_SSH_RE =
  /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]{0,38})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99}?)(?:\.git)?$/;

export function parseGithubUrlClient(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const m = GITHUB_HTTPS_RE.exec(trimmed) ?? GITHUB_SSH_RE.exec(trimmed);
  if (!m) return null;
  if (/^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) return null;
  return { owner: m[1], repo: m[2] };
}

/** Kebab-cased slug from a repo name — the backend derives identically. */
export function deriveSlugFromRepo(repo: string): string {
  return repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Error-code → copy map (memo design: centralized errorCodeToCopy) ───────
// Covers BOTH routes' codes: hives/from-repo (clone_-prefixed + hive codes)
// and the standalone projects route (bare clone codes).

export function errorCodeToCopy(code: string | undefined, raw: string, hiveLower = 'hive'): string {
  switch (code) {
    case 'invalid_url':
      return 'That doesn’t look like a GitHub repository URL. Paste a link like https://github.com/owner/repo.';
    case 'invalid_slug':
      return 'That slug isn’t valid — lowercase letters, digits, and hyphens only.';
    case 'hive_not_found':
      return `The selected ${hiveLower} wasn’t found — it may have been removed. Go back and pick another.`;
    case 'slug_exhausted':
      return 'No free slug variant was found. Customize the slug under Advanced and retry.';
    case 'clone_dest_exists':
    case 'dest_exists':
      return 'A clone of this repository already exists on disk. Remove it (or customize the slug) and retry.';
    case 'clone_auth_required':
    case 'auth_required':
      return 'GitHub authentication required. Run `gh auth login` in your terminal, then retry.';
    case 'clone_not_found':
    case 'not_found':
      return 'Repository not found on GitHub. Check the URL — for a private repo, run `gh auth login` first.';
    case 'clone_git_missing':
    case 'git_missing':
      return 'git was not found in PATH. Install git and try again.';
    case 'blueprint_failed':
      return `Cloned fine, but blueprint detection failed: ${raw || 'unknown detection error'}.`;
    case 'member_create_failed':
      return `Cloned fine, but registering the member harness failed: ${raw || code}.`;
    default:
      if (code?.startsWith('hive_')) {
        return `Cloned fine, but standing up the ${hiveLower} failed: ${raw || code}.`;
      }
      if (code?.startsWith('clone_')) {
        return `Cloning failed: ${raw || code}.`;
      }
      return raw || 'An unexpected error occurred.';
  }
}

// ── Progress strip (memo design, hive step vocabulary) ─────────────────────

export type StripStepId = 'resolve' | 'lookup' | 'clone' | 'detect' | 'create' | 'publish';
type StripStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

const STRIP_LABELS: Record<StripStepId, string> = {
  resolve: 'Resolving repository',
  lookup: 'Checking for an existing hive',
  clone: 'Cloning repository',
  detect: 'Detecting blueprint',
  create: 'Creating',
  publish: 'Publishing',
};

/** Which strip step a backend error code failed at (settled from real data). */
export function stepForErrorCode(code: string | undefined): StripStepId {
  switch (code) {
    case 'invalid_url':
    case 'invalid_slug':
      return 'resolve';
    case 'hive_not_found':
      return 'lookup';
    case 'clone_dest_exists':
    case 'dest_exists':
    case 'clone_auth_required':
    case 'auth_required':
    case 'clone_not_found':
    case 'not_found':
    case 'clone_git_missing':
    case 'git_missing':
      return 'clone';
    case 'blueprint_failed':
      return 'detect';
    default:
      // slug_exhausted, hive_*, member_create_failed, unknown — the create leg.
      return 'create';
  }
}

function statusMap(entries: [StripStepId, StripStatus][]): Partial<Record<StripStepId, StripStatus>> {
  return Object.fromEntries(entries) as Partial<Record<StripStepId, StripStatus>>;
}

function stepsForMode(mode: FormMode): StripStepId[] {
  return mode === 'standalone'
    ? ['resolve', 'clone', 'detect', 'create']
    : ['resolve', 'lookup', 'clone', 'detect', 'create', 'publish'];
}

/** Rough per-step holds for the optimistic spinner (clone is the long pole). */
const OPTIMISTIC_HOLD_MS: Record<StripStepId, number> = {
  resolve: 900,
  lookup: 1400,
  clone: 20_000,
  detect: 12_000,
  create: 8_000,
  publish: 6_000,
};

function ProgressStrip({ steps }: { steps: { id: StripStepId; status: StripStatus }[] }) {
  return (
    <div
      data-testid="github-url-progress"
      style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 16px', marginBottom: 14 }}
    >
      <style>{`@keyframes pc-gh-spin { to { transform: rotate(360deg); } }`}</style>
      {steps.map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', opacity: s.status === 'pending' || s.status === 'skipped' ? 0.5 : 1 }}>
          <span style={{ width: 16, minWidth: 16, textAlign: 'center', fontSize: 13, lineHeight: 1 }}>
            {s.status === 'done' && <span style={{ color: 'var(--success, #22c55e)', fontWeight: 700 }}>✓</span>}
            {s.status === 'error' && <span style={{ color: 'var(--bad, #ef4444)', fontWeight: 700 }}>✕</span>}
            {s.status === 'skipped' && <span style={{ color: 'var(--fg-dim, #888)' }}>—</span>}
            {s.status === 'pending' && <span style={{ color: 'var(--fg-dim, #888)' }}>○</span>}
            {s.status === 'running' && (
              <span
                style={{ display: 'inline-block', width: 12, height: 12, border: '2px solid var(--accent, #6366f1)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'pc-gh-spin 0.7s linear infinite' }}
              />
            )}
          </span>
          <span style={{ fontSize: 13, fontWeight: s.status === 'running' ? 600 : 400 }}>
            {STRIP_LABELS[s.id]}
            {s.status === 'skipped' && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--fg-mute)' }}>skipped</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Response shapes (the P-006..P-010 contracts) ───────────────────────────

interface HiveHit {
  hiveId: string;
  title: string;
  ownerGithubLogin?: string;
  hivePubkey?: string;
  memberLinks?: string[];
  claimStatus?: string;
}

interface ExistingOffer {
  kind: 'hive' | 'legacy_shared_harness';
  hive?: HiveHit;
  binding?: { harnessSlug: string; harnessLink?: string; claimStatus?: string };
  coords?: { owner: string; repo: string };
  source?: string;
  bindingUnverified?: boolean;
}

interface PublishOutcome {
  announced?: boolean;
  inviteSecret?: string;
  cupboard?: { attempted?: boolean; rowsCreated?: number; rowsFailed?: number; errors?: string[]; skipped?: string };
  skipped?: 'private' | 'unpublished_hive';
}

interface CreatedResult {
  hiveSlug: string;
  memberSlug: string;
  memberPath: string;
  defaultBranch?: string;
  githubRepositoryId?: number;
  duplicateOf?: { kind: 'hive' | 'legacy_shared_harness'; hivePubkey?: string; source: string };
}

interface FromRepoResponse {
  ok?: boolean;
  existing?: ExistingOffer;
  created?: CreatedResult;
  bindingUnverified?: boolean;
  publish?: PublishOutcome;
  error?: string;
  code?: string;
}

interface StandaloneResponse {
  ok?: boolean;
  project?: { slug: string; path: string };
  blueprint?: { generated?: boolean };
  clone?: { url: string; owner: string; repo: string; defaultBranch?: string };
  error?: string;
  code?: string;
}

// ── Component ───────────────────────────────────────────────────────────────

export type FormMode = 'new-hive' | 'into-hive' | 'standalone';
type Visibility = 'public' | 'invite' | 'private';
type Phase = 'form' | 'running' | 'error' | 'offer' | 'joining' | 'joined' | 'created';

export interface EntryGithubUrlFormProps {
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
  padding: '7px 10px',
  background: 'var(--bg-2)',
  border: '1px solid var(--border)',
  borderRadius: 5,
  color: 'var(--fg)',
  fontFamily: 'inherit',
  fontSize: 13,
  boxSizing: 'border-box',
};

function Hint({ children }: { children: ReactNode }) {
  return <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--fg-mute)' }}>{children}</p>;
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div role="alert" style={{ background: 'var(--bad-bg, rgba(255,80,80,0.08))', border: '1px solid var(--bad)', color: 'var(--bad)', borderRadius: 5, padding: '8px 12px', fontSize: 13, marginBottom: 14 }}>
      {message}
    </div>
  );
}

function InfoCard({ children }: { children: ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', marginBottom: 14, fontSize: 12.5, lineHeight: 1.5, color: 'var(--fg-dim)' }}>
      {children}
    </div>
  );
}

export function EntryGithubUrlForm({ onBack, onCreated, hiveScope = null, initialMode = 'new-hive' }: EntryGithubUrlFormProps) {
  const t = useLexicon();
  const hiveLabel = t('pot'); // "Hive" | "Pot"
  const hiveLower = t('pot', { lower: true });

  // Transient form drafts — useState per the nuqs transient-lifecycle exception.
  const [mode, setMode] = useState<FormMode>(initialMode === 'into-hive' && !hiveScope ? 'new-hive' : initialMode);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customSlug, setCustomSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);

  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState('');
  const [stepStatuses, setStepStatuses] = useState<Partial<Record<StripStepId, StripStatus>>>({});
  const [offer, setOffer] = useState<ExistingOffer | null>(null);
  const [offerUnverified, setOfferUnverified] = useState(false);
  const [created, setCreated] = useState<{ kind: 'hive'; result: CreatedResult; publish?: PublishOutcome; bindingUnverified: boolean } | { kind: 'standalone'; slug: string; path: string; blueprintGenerated?: boolean } | null>(null);
  const [joinSummary, setJoinSummary] = useState<{ ok: number; total: number; firstSlug?: string } | null>(null);

  const parsed = parseGithubUrlClient(url);
  const derivedSlug = parsed ? deriveSlugFromRepo(parsed.repo) : '';
  const effectiveSlug = slugTouched && customSlug.trim() ? customSlug.trim() : derivedSlug;

  // ── Optimistic spinner: advance the RUNNING marker on a rough schedule;
  //    done/failed settle from the real response only (honesty rule).
  const activeSteps = stepsForMode(mode);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => clearTimer, []);

  const startOptimistic = (steps: StripStepId[]) => {
    clearTimer();
    let idx = 0;
    setStepStatuses(statusMap(steps.map((s, i) => [s, i === 0 ? 'running' : 'pending'])));
    const advance = () => {
      if (idx >= steps.length - 1) return; // hold on the last step until the response
      timerRef.current = setTimeout(() => {
        idx += 1;
        setStepStatuses((prev) => {
          const next = { ...prev };
          for (let i = 0; i < steps.length; i++) {
            // Past steps stay visually pending (no fabricated checkmarks);
            // only the cursor carries the spinner. Honesty rule: done/failed
            // are settled exclusively from the real response.
            next[steps[i]] = i === idx ? 'running' : 'pending';
          }
          return next;
        });
        advance();
      }, OPTIMISTIC_HOLD_MS[steps[idx]]);
    };
    advance();
  };

  const settleError = (steps: StripStepId[], code: string | undefined) => {
    clearTimer();
    const failedAt = stepForErrorCode(code);
    const failIdx = steps.indexOf(failedAt);
    setStepStatuses(
      statusMap(steps.map((s, i) => [s, i < failIdx ? 'done' : i === failIdx ? 'error' : 'pending'])),
    );
  };

  const settleCreated = (steps: StripStepId[], publish: PublishOutcome | undefined) => {
    clearTimer();
    setStepStatuses(
      statusMap(
        steps.map((s) => {
          if (s !== 'publish') return [s, 'done'];
          if (!publish || publish.skipped) return [s, 'skipped'];
          return [s, publish.announced ? 'done' : 'error'];
        }),
      ),
    );
  };

  // ── Submit ────────────────────────────────────────────────────────────────

  const submit = async (opts?: { force?: boolean }) => {
    const trimmed = url.trim();
    if (!parseGithubUrlClient(trimmed)) {
      setUrlError('Not a valid GitHub repository URL (https://github.com/owner/repo or git@github.com:owner/repo).');
      return;
    }
    setUrlError('');
    setError('');
    setPhase('running');
    const steps = stepsForMode(mode);
    startOptimistic(steps);

    try {
      if (mode === 'standalone') {
        // D-007: the projects-route githubUrl path — clone + register + blueprint.
        const res = await fetch('/api/harness/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: effectiveSlug, githubUrl: trimmed }),
        });
        const body: StandaloneResponse = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok || !body.project) {
          settleError(steps, body.code);
          setError(errorCodeToCopy(body.code, body.error ?? `HTTP ${res.status}`, hiveLower));
          setPhase('error');
          return;
        }
        clearTimer();
        setStepStatuses(statusMap(steps.map((s) => [s, s === 'detect' && body.blueprint?.generated === false ? 'skipped' : 'done'])));
        setCreated({ kind: 'standalone', slug: body.project.slug, path: body.project.path, blueprintGenerated: body.blueprint?.generated });
        setPhase('created');
        return;
      }

      const res = await fetch('/api/harness/hives/from-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          githubUrl: trimmed,
          ...(slugTouched && customSlug.trim() ? { slug: customSlug.trim() } : {}),
          ...(mode === 'new-hive' ? { visibility } : {}),
          ...(mode === 'into-hive' && hiveScope ? { intoHive: hiveScope } : {}),
          ...(opts?.force ? { force: true } : {}),
        }),
      });
      const body: FromRepoResponse = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        settleError(steps, body.code);
        setError(errorCodeToCopy(body.code, body.error ?? `HTTP ${res.status}`, hiveLower));
        setPhase('error');
        return;
      }
      if (body.existing) {
        // Join offer — zero side effects happened. Resolve+lookup are real.
        clearTimer();
        setStepStatuses({ resolve: 'done', lookup: 'done' });
        setOffer(body.existing);
        setOfferUnverified(body.existing.bindingUnverified === true);
        setPhase('offer');
        return;
      }
      if (body.created) {
        settleCreated(steps, body.publish);
        setCreated({ kind: 'hive', result: body.created, publish: body.publish, bindingUnverified: body.bindingUnverified === true });
        setPhase('created');
        return;
      }
      settleError(steps, undefined);
      setError('Unexpected response from the server.');
      setPhase('error');
    } catch (e: unknown) {
      settleError(steps, undefined);
      setError((e as Error).message ?? 'Network error');
      setPhase('error');
    }
  };

  // ── Join an existing hive (the WorkbenchHiveDirectoryPanel mechanics) ────

  const join = async () => {
    if (!offer) return;
    const links =
      offer.kind === 'hive'
        ? offer.hive?.memberLinks ?? []
        : offer.binding?.harnessLink
          ? [offer.binding.harnessLink]
          : [];
    if (links.length === 0) return;
    setPhase('joining');
    let ok = 0;
    let firstSlug: string | undefined;
    for (let i = 0; i < links.length; i++) {
      // Per-repo slug from the link's own github coords (falls back to an
      // indexed hive id — the directory panel's scheme).
      const parsedLink = parseHarnessLink(links[i]);
      const slug = parsedLink.ok
        ? deriveSlugFromRepo(parsedLink.payload.github_repo)
        : offer.kind === 'hive'
          ? `${offer.hive?.hiveId ?? 'hive'}-${i}`
          : offer.binding?.harnessSlug || `joined-${i}`;
      try {
        const res = await fetch('/api/harness/join-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, harnessLinkUrl: links[i] }),
        });
        if (res.ok) {
          ok += 1;
          if (!firstSlug) firstSlug = slug;
        }
      } catch {
        /* per-link best-effort, same as the directory panel */
      }
    }
    setJoinSummary({ ok, total: links.length, ...(firstSlug ? { firstSlug } : {}) });
    setPhase('joined');
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const backBtnStyle: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--fg-dim)', cursor: 'pointer', padding: 0, fontSize: 13, marginBottom: 16 };
  const secondaryBtn: React.CSSProperties = { padding: '7px 14px', fontSize: 13, background: 'transparent', border: '1px solid var(--border)', color: 'var(--fg-dim)', borderRadius: 5, cursor: 'pointer' };
  const primaryBtn: React.CSSProperties = { padding: '7px 16px', fontSize: 13, background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--accent-ink, #051827)', borderRadius: 5, cursor: 'pointer', fontWeight: 600 };

  // Running / error: the progress strip front and center.
  if (phase === 'running' || phase === 'error') {
    return (
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>
          {phase === 'running' ? (mode === 'standalone' ? 'Cloning repository…' : `Creating ${hiveLower} from repository…`) : 'Create failed'}
        </h2>
        {parsed && (
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--fg-dim)' }}>
            {parsed.owner}/{parsed.repo}
          </p>
        )}
        {phase === 'error' && error && <ErrorBanner message={error} />}
        <ProgressStrip steps={activeSteps.map((id) => ({ id, status: stepStatuses[id] ?? 'pending' }))} />
        {phase === 'running' && (
          <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--fg-mute)' }}>
            Cloning and verifying can take a few minutes for large repositories.
          </p>
        )}
        {phase === 'error' && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" onClick={onBack} style={secondaryBtn}>Back</button>
            <button type="button" onClick={() => setPhase('form')} style={primaryBtn}>Edit &amp; retry</button>
          </div>
        )}
      </div>
    );
  }

  // Join offer — the confirm card (P-008 UI half).
  if ((phase === 'offer' || phase === 'joining' || phase === 'joined') && offer) {
    const isHive = offer.kind === 'hive';
    const title = isHive ? offer.hive?.title : offer.binding?.harnessSlug;
    const ownerLogin = isHive ? offer.hive?.ownerGithubLogin : undefined;
    const claimStatus = isHive ? offer.hive?.claimStatus : offer.binding?.claimStatus;
    const links = isHive
      ? offer.hive?.memberLinks ?? []
      : offer.binding?.harnessLink
        ? [offer.binding.harnessLink]
        : [];
    const joinable = links.length > 0;
    return (
      <div>
        <button type="button" onClick={onBack} style={backBtnStyle}>← Back</button>
        <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>
          {isHive ? `A ${hiveLower} already exists for this repository` : 'A shared harness already exists for this repository'}
        </h2>
        <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '14px 16px', marginBottom: 14 }}>
          <p style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>{title || '(untitled)'}</p>
          {ownerLogin && <p style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--fg-dim)' }}>owner: {ownerLogin}</p>}
          {claimStatus && <p style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--fg-dim)' }}>claim status: {claimStatus}</p>}
          {isHive && joinable && (
            <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-dim)' }}>
              {links.length} member harness{links.length === 1 ? '' : 'es'}
            </p>
          )}
          {offerUnverified && (
            <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--fg-mute)' }}>
              The central index could not be reached — this match comes from the P2P directory only.
            </p>
          )}
        </div>
        {!joinable && phase === 'offer' && (
          <InfoCard>
            This {isHive ? hiveLower : 'harness'} exists but isn&rsquo;t joinable yet — its owner hasn&rsquo;t
            published join links. You can create your own anyway; it will be flagged as a duplicate until
            the claim/supersede flow resolves ownership.
          </InfoCard>
        )}
        {phase === 'joining' && <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-dim)' }}>Joining…</p>}
        {phase === 'joined' && joinSummary && (
          <div style={{ marginBottom: 14 }}>
            <p style={{ margin: '0 0 6px', fontSize: 13 }}>
              Joined {joinSummary.ok}/{joinSummary.total} member harness{joinSummary.total === 1 ? '' : 'es'}.
            </p>
            {joinSummary.ok === 0 && <ErrorBanner message="No member harness could be joined. Check your GitHub auth (gh auth login) and retry." />}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {phase === 'offer' && (
            <>
              <button type="button" onClick={onBack} style={secondaryBtn}>Cancel</button>
              {!joinable && (
                <button type="button" onClick={() => void submit({ force: true })} style={secondaryBtn}>
                  Create anyway
                </button>
              )}
              {joinable && (
                <button type="button" onClick={() => void join()} style={primaryBtn}>
                  {isHive ? `Join ${hiveLower}` : 'Join harness'}
                </button>
              )}
            </>
          )}
          {phase === 'joined' && (
            <button
              type="button"
              onClick={() => {
                if (joinSummary?.firstSlug) onCreated(joinSummary.firstSlug);
                else onBack();
              }}
              style={primaryBtn}
            >
              Done
            </button>
          )}
        </div>
      </div>
    );
  }

  // Created — the success summary.
  if (phase === 'created' && created) {
    if (created.kind === 'standalone') {
      return (
        <div>
          <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>✓ Harness created</h2>
          <InfoCard>
            <code>{created.slug}</code> registered at <code>{created.path}</code>.{' '}
            {created.blueprintGenerated
              ? 'A blueprint was detected and written — it’s ready to run.'
              : 'No blueprint was generated — configure one from the harness settings.'}
          </InfoCard>
          <div style={{ textAlign: 'right' }}>
            <button type="button" onClick={() => onCreated(created.slug)} style={primaryBtn}>Done</button>
          </div>
        </div>
      );
    }
    const { result, publish, bindingUnverified } = created;
    const intoExisting = mode === 'into-hive';
    return (
      <div>
        <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>
          ✓ {intoExisting ? `Added to ${result.hiveSlug}` : `${hiveLabel} created`}
        </h2>
        <ProgressStrip steps={activeSteps.map((id) => ({ id, status: stepStatuses[id] ?? 'pending' }))} />
        <InfoCard>
          <div>
            {hiveLabel}: <code>{result.hiveSlug}</code> · member: <code>{result.memberSlug}</code>
            {result.defaultBranch ? <> · default branch <code>{result.defaultBranch}</code></> : null}
          </div>
          <div style={{ marginTop: 6 }}>
            {publish?.skipped === 'private' && <>Not published — private {hiveLower}s make zero external writes. Publish later from the {hiveLower} header.</>}
            {publish?.skipped === 'unpublished_hive' && <>The {hiveLower} isn&rsquo;t published, so the new member stays unlisted until it is.</>}
            {publish && !publish.skipped && (
              <>
                {publish.announced
                  ? <>Announced to the {hiveLower} directory.</>
                  : <span style={{ color: 'var(--bad)' }}>Directory announce failed — it will retry on the next re-announce tick.</span>}
                {publish.cupboard?.attempted && (
                  <> Central listing: {publish.cupboard.rowsCreated ?? 0} row{(publish.cupboard.rowsCreated ?? 0) === 1 ? '' : 's'} created{(publish.cupboard.rowsFailed ?? 0) > 0 ? `, ${publish.cupboard.rowsFailed} failed` : ''}.</>
                )}
              </>
            )}
          </div>
        </InfoCard>
        {publish?.inviteSecret && (
          <div style={{ background: 'var(--bg-2)', border: '1px solid var(--accent)', borderRadius: 8, padding: '12px 14px', marginBottom: 14 }}>
            <p style={{ margin: '0 0 6px', fontSize: 12.5, fontWeight: 600 }}>Invite secret</p>
            <code data-testid="invite-secret" style={{ display: 'block', fontSize: 12, wordBreak: 'break-all' }}>{publish.inviteSecret}</code>
            <Hint>Share this with people you invite — it is not shown again.</Hint>
          </div>
        )}
        {result.duplicateOf && (
          <div role="alert" style={{ background: 'var(--bad-bg, rgba(255,180,80,0.08))', border: '1px solid var(--warn, #f59e0b)', color: 'var(--warn, #f59e0b)', borderRadius: 5, padding: '8px 12px', fontSize: 12.5, marginBottom: 14 }}>
            Created as a duplicate of an existing {result.duplicateOf.kind === 'hive' ? hiveLower : 'shared harness'} ({result.duplicateOf.source}).
            Ownership resolves through the claim/supersede flow.
          </div>
        )}
        {bindingUnverified && (
          <Hint>The central index couldn&rsquo;t be reached during the lookup — the binding reconciles automatically on the next re-announce.</Hint>
        )}
        <div style={{ textAlign: 'right', marginTop: 12 }}>
          <button
            type="button"
            onClick={() =>
              intoExisting
                ? onCreated(result.memberSlug, { hive: result.hiveSlug })
                : onCreated(result.hiveSlug)
            }
            style={primaryBtn}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  // The form.
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const modeBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '6px 10px',
    fontSize: 12,
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
    <form onSubmit={handleSubmit}>
      <button type="button" onClick={onBack} style={backBtnStyle}>← Back</button>
      <h2 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>GitHub URL</h2>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--fg-dim)', lineHeight: 1.5 }}>
        Forks nothing — clones the repository and registers it. If a {hiveLower} already exists for this repo
        you&rsquo;ll be offered to join it instead.
      </p>

      {/* The 3-mode fork (P-012): new-hive is the entry's default. */}
      <div role="group" aria-label="Creation mode" style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        <button type="button" aria-pressed={mode === 'new-hive'} onClick={() => setMode('new-hive')} style={modeBtn(mode === 'new-hive')} title={`Create a new ${hiveLower} from this repository`}>
          New {hiveLower}
        </button>
        {hiveScope && (
          <button type="button" aria-pressed={mode === 'into-hive'} onClick={() => setMode('into-hive')} style={modeBtn(mode === 'into-hive')} title={`Add the repo as a member of ${hiveScope}`}>
            Add to {hiveScope}
          </button>
        )}
        <button type="button" aria-pressed={mode === 'standalone'} onClick={() => setMode('standalone')} style={modeBtn(mode === 'standalone')} title={`A standalone harness — no ${hiveLower}, no publish`}>
          Standalone
        </button>
      </div>

      <label style={{ display: 'block', marginBottom: 14 }}>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-dim)', marginBottom: 4, fontWeight: 500 }}>Repository URL</span>
        <input
          type="text"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setUrlError(''); }}
          placeholder="https://github.com/owner/repo"
          style={{ ...inputStyle, ...(urlError ? { border: '1px solid var(--bad, #ef4444)' } : {}) }}
          autoFocus
        />
        {urlError ? (
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bad, #ef4444)' }}>{urlError}</p>
        ) : (
          <Hint>https://github.com/owner/repo or git@github.com:owner/repo. Private repos need `gh auth login`.</Hint>
        )}
      </label>

      {mode === 'new-hive' && (
        <fieldset style={{ border: 'none', padding: 0, margin: '0 0 14px' }}>
          <legend style={{ fontSize: 12, color: 'var(--fg-dim)', fontWeight: 500, padding: 0, marginBottom: 6 }}>Visibility</legend>
          {(
            [
              {
                v: 'public' as const,
                label: 'Public',
                hint: `Anyone on the network can discover this ${hiveLower}; contributors' GitHub identities are visible.`,
              },
              {
                v: 'invite' as const,
                label: 'Invite',
                hint: `Hidden from the public directory — joinable only with the invite secret generated at publish.`,
              },
              {
                v: 'private' as const,
                label: 'Private',
                hint: `Nothing leaves this machine — no announce, no central listing. Publish later anytime.`,
              },
            ]
          ).map(({ v, label, hint }) => (
            <label key={v} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: visibility === v ? 'var(--bg-2)' : 'transparent' }}>
              <input
                type="radio"
                name="hive-visibility"
                value={v}
                checked={visibility === v}
                onChange={() => setVisibility(v)}
                style={{ marginTop: 2 }}
              />
              <span>
                <span style={{ display: 'block', fontSize: 13, fontWeight: visibility === v ? 600 : 500 }}>{label}{v === 'public' ? ' (default)' : ''}</span>
                <span style={{ display: 'block', fontSize: 11.5, color: 'var(--fg-mute)', lineHeight: 1.45 }}>{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <div style={{ marginBottom: 14 }}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          style={{ background: 'none', border: 'none', color: 'var(--fg-dim)', cursor: 'pointer', padding: 0, fontSize: 12 }}
        >
          {advancedOpen ? '▾' : '▸'} Advanced: customize slug
        </button>
        {advancedOpen && (
          <label style={{ display: 'block', marginTop: 8 }}>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--fg-dim)', marginBottom: 4, fontWeight: 500 }}>Slug</span>
            <input
              type="text"
              value={slugTouched ? customSlug : derivedSlug}
              onChange={(e) => { setCustomSlug(e.target.value); setSlugTouched(true); }}
              placeholder={derivedSlug || 'my-repo'}
              pattern="[a-z0-9][a-z0-9-]*"
              title="lowercase alphanumeric, hyphens OK"
              style={inputStyle}
            />
            <Hint>
              Auto-derived from the repo name{derivedSlug ? <>: <code>{derivedSlug}</code></> : null}.
              {mode === 'new-hive' ? <> The {hiveLower} home becomes <code>{(effectiveSlug || 'repo') + '-hive'}</code>.</> : null}
            </Hint>
          </label>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button type="button" onClick={onBack} style={secondaryBtn}>Cancel</button>
        <button type="submit" disabled={!url.trim()} style={{ ...primaryBtn, opacity: url.trim() ? 1 : 0.5, cursor: url.trim() ? 'pointer' : 'not-allowed' }}>
          {mode === 'standalone' ? 'Clone & register' : mode === 'into-hive' ? `Add to ${hiveScope}` : `Create ${hiveLower}`}
        </button>
      </div>
    </form>
  );
}
