'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { PRODUCT_TUTORIAL_LESSONS, PRODUCT_TUTORIAL_TARGETS, productTutorialLessonIds, productTutorialTargetAvailability } from '@papercusp/operator-core/lib/onboarding/product-tutorial-lesson';
import type { AccountTutorialProgressRecord } from '@papercusp/operator-core/lib/onboarding/cloud-tutorial-progress';

const endpoint = '/api/hosted/browser/onboarding/tutorial-progress?scope=account&version=3';
export interface ProductTutorialAccount { tenantId: string; userId: string; sessionId: string; workspaceId: string | null }
/** Explicit guide navigation may enter the existing shell before workspace
 * selection. Panel/search URLs otherwise return to the first-workspace card. */
export function productTutorialDestination(route: string, workspaceId: string | null): string {
  if (workspaceId || !route.startsWith('/?')) return route;
  const params = new URLSearchParams(route.slice(2));
  params.set('firstRun', 'deferred');
  return `/?${params.toString()}`;
}
export function validProductTutorialRecord(value: unknown, account: ProductTutorialAccount): value is AccountTutorialProgressRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as AccountTutorialProgressRecord;
  return row.version === 3 && Number.isSafeInteger(row.revision) && row.revision >= 0 &&
    row.scope?.tenantId === account.tenantId && row.scope.userId === account.userId &&
    ['active', 'paused', 'skipped', 'closed'].includes(row.disposition) && productTutorialLessonIds.has(row.currentLessonId) &&
    Array.isArray(row.reviewedLessonIds) && row.reviewedLessonIds.every(id => productTutorialLessonIds.has(id)) &&
    new Set(row.reviewedLessonIds).size === row.reviewedLessonIds.length;
}

/** Account entry wraps the host's existing first-run/shell choice. It never
 * mounts that workspace UI while an enrolled guide is active. */
export function AccountProductTutorial({ account, sessionSignal = 'valid', children }: { account: ProductTutorialAccount; sessionSignal?: string; children: ReactNode | ((guideControls: ReactNode) => ReactNode) }) {
  const [record, setRecord] = useState<AccountTutorialProgressRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [continueUnavailable, setContinueUnavailable] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const resume = useRef<HTMLButtonElement>(null);
  const requestedFocus = useRef<'heading' | 'resume' | null>(null);
  // A destination provider may replace its startup wrapper after this guide's
  // effect has run. Transfer the focus intent only when it replaces our focused
  // control; an ordinary destination update must not steal the user's focus.
  const attachResume = useCallback((node: HTMLButtonElement | null) => {
    if (!node && requestedFocus.current !== 'heading' && resume.current === document.activeElement) requestedFocus.current = 'resume';
    resume.current = node;
    if (node && !node.disabled && requestedFocus.current === 'resume') {
      node.focus(); requestedFocus.current = null;
    }
  }, []);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const pending = useRef<{ body: string; patch: Pick<AccountTutorialProgressRecord, 'disposition' | 'currentLessonId' | 'reviewedLessonIds'>; href?: string } | null>(null);
  const identity = `${account.tenantId}:${account.userId}:${account.sessionId}`;
  const currentLesson = record ? PRODUCT_TUTORIAL_LESSONS.find(lesson => lesson.id === record.currentLessonId) : null;

  useEffect(() => {
    mounted.current = true;
    const abort = new AbortController();
    operation.current?.abort(); operation.current = abort;
    pending.current = null;
    requestedFocus.current = null;
    setLoading(true); setRecord(null); setError(null); setContinueUnavailable(false); setBusy(false);
    fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error('unavailable');
        const body: unknown = await response.json();
        const value = (body as { record?: unknown })?.record;
        if (value !== null && !validProductTutorialRecord(value, account)) throw new Error('scope_changed');
        if (!abort.signal.aborted) setRecord(value as AccountTutorialProgressRecord | null);
      }).catch(() => { if (!abort.signal.aborted) setError('Your guide could not be loaded. Check your session and try again.'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { mounted.current = false; operation.current?.abort(); abort.abort(); };
  }, [identity, reload]);
  useEffect(() => { if (sessionSignal !== 'valid') { operation.current?.abort(); pending.current = null; setBusy(false); } }, [sessionSignal]);
  // A frame scheduled by save can precede a concurrent React commit. Wait for
  // the committed, enabled control so the requested focus cannot be lost.
  useEffect(() => {
    if (busy || loading || sessionSignal !== 'valid' || !requestedFocus.current) return;
    const target = requestedFocus.current === 'heading' ? heading.current : resume.current;
    if (target) { target.focus(); requestedFocus.current = null; }
  }, [record, busy, loading, sessionSignal]);

  async function save(patch: Pick<AccountTutorialProgressRecord, 'disposition' | 'currentLessonId' | 'reviewedLessonIds'>, href?: string) {
    if (!record || busy || sessionSignal !== 'valid') return;
    const mutation = pending.current ?? { patch, href, body: JSON.stringify({ disposition: patch.disposition,
      currentLessonId: patch.currentLessonId, reviewedLessonIds: patch.reviewedLessonIds, expectedScope: record.scope,
      expectedRevision: record.revision, mutationId: crypto.randomUUID(), version: 3 }) };
    pending.current = mutation;
    operation.current?.abort();
    const abort = new AbortController(); operation.current = abort;
    setBusy(true); setError(null);
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', signal: abort.signal,
        headers: { 'content-type': 'application/json' }, body: mutation.body });
      const body = await response.json() as { record?: unknown };
      if (abort.signal.aborted || !mounted.current) return;
      if (!validProductTutorialRecord(body.record, account)) throw new Error('scope_changed');
      if (response.status === 409) {
        pending.current = null;
        setRecord(body.record); setError('Another tab changed your guide. Review the current lesson, then try your choice again.'); return;
      }
      if (!response.ok) throw new Error('unavailable');
      pending.current = null;
      if (!mutation.href) requestedFocus.current = mutation.patch.disposition === 'active' ? 'heading' : 'resume';
      setRecord(body.record);
      if (mutation.href) { window.location.assign(mutation.href); return; }
    } catch { if (!abort.signal.aborted && mounted.current) setError('Your choice was not saved. Check your connection and try again.'); }
    finally { if (!abort.signal.aborted && mounted.current) setBusy(false); }
  }
  if (sessionSignal !== 'valid') return <main className="welcome-state"><h1>Check your session</h1><p role="alert">Your session could not be verified. Guide changes are paused.</p><a href="/api/hosted/auth/sign-in?intent=sign-in">Sign in</a>{' · '}<a href="/docs">Public Docs</a></main>;
  if (loading) return <main className="welcome-state" aria-busy="true"><p role="status">Loading your product guide…</p></main>;
  if (error && !record && !continueUnavailable) return <main className="welcome-state"><h1>Product guide unavailable</h1><p role="alert">{error}</p>
    <button onClick={() => setReload(value => value + 1)}>Try again</button>{' '}<button onClick={() => setContinueUnavailable(true)}>Continue to Papercusp</button>{' '}<a href="/docs">Public Docs</a></main>;
  if (!record || record.disposition !== 'active') {
    // The destination owns placement: a modal host must place these controls
    // inside its existing dialog, rather than behind its blocking backdrop.
    const guideControls = record && <aside className="product-guide-return" aria-label="Product guide">
    <style>{PRODUCT_GUIDE_CSS}</style>
    <button ref={attachResume} disabled={busy} onClick={() => save({ ...record, disposition: 'active' })}>{record.disposition === 'closed' ? 'Review product guide' : 'Resume product guide'}</button>
    {currentLesson && <details><summary>Help with {currentLesson.title}</summary><p>{currentLesson.help}</p><a href="/docs">Read public Docs</a></details>}
    {error && <p role="alert">{error}</p>}</aside>;
    return typeof children === 'function' ? children(guideControls) : <>{guideControls}{children}</>;
  }
  const position = PRODUCT_TUTORIAL_LESSONS.findIndex(lesson => lesson.id === record.currentLessonId);
  const lesson = PRODUCT_TUTORIAL_LESSONS[position];
  const targets = PRODUCT_TUTORIAL_TARGETS.filter(target => target.module === lesson.id);
  const choice = (disposition: AccountTutorialProgressRecord['disposition']) => save({ ...record, disposition });
  const move = (next: number, reviewed = false) => save({ disposition: 'active', currentLessonId: PRODUCT_TUTORIAL_LESSONS[next].id,
    reviewedLessonIds: reviewed ? Array.from(new Set([...record.reviewedLessonIds, lesson.id])) : record.reviewedLessonIds });
  return <main className="product-guide" aria-labelledby="product-guide-title">
    <style>{PRODUCT_GUIDE_CSS}</style>
    <p>Product guide · Lesson {position + 1} of {PRODUCT_TUTORIAL_LESSONS.length}</p>
    <h1 id="product-guide-title" ref={heading} tabIndex={-1}>{lesson.title}</h1>
    <p>{lesson.introduction}</p>
    <nav aria-label="Product guide lessons"><ol>{PRODUCT_TUTORIAL_LESSONS.map((entry, index) => <li key={entry.id}>
      <button disabled={busy} aria-current={entry.id === lesson.id ? 'step' : undefined} onClick={() => move(index)}>{entry.title}{record.reviewedLessonIds.includes(entry.id) ? ' · Reviewed' : ''}</button>
    </li>)}</ol></nav>
    <section aria-label="Try these destinations"><h2>Find it in Papercusp</h2>
      {targets.length ? <ul>{targets.map(target => {
        const unavailable = productTutorialTargetAvailability(target, account.workspaceId);
        const href = productTutorialDestination(target.route, account.workspaceId);
        return <li key={target.id}><strong>{target.id}</strong><p>{target.teaches}</p>{unavailable ? <p>{unavailable}</p> :
          <a href={href} onClick={event => { event.preventDefault(); if (!busy) void save({ ...record, disposition: 'paused' }, href); }}>Open {target.id}</a>}</li>;
      })}</ul> : <p>You can read this lesson before selecting a workspace. The navigation lesson shows where the product controls live.</p>}
    </section>
    <details><summary>Help with this lesson</summary><p>{lesson.help}</p><a href="/docs">Read public Docs</a>{' · '}<a href="/?app=support" onClick={event => { event.preventDefault(); if (!busy) void save({ ...record, disposition: 'paused' }, '/?app=support'); }}>Open Support</a></details>
    <p role="status">{busy ? 'Saving your choice…' : `${record.reviewedLessonIds.length} explanations reviewed. Product tasks are verified separately.`}</p>
    {error && <p role="alert">{error}</p>}{pending.current && error && <button disabled={busy} onClick={() => save(pending.current!.patch, pending.current!.href)}>Retry saving choice</button>}
    <div className="product-guide-actions">
      <button disabled={busy || position === 0} onClick={() => move(position - 1)}>Back</button>
      {position + 1 < PRODUCT_TUTORIAL_LESSONS.length ? <button disabled={busy} onClick={() => move(position + 1, true)}>Reviewed — next lesson</button> :
        <button disabled={busy} onClick={() => save({ ...record, disposition: 'closed', reviewedLessonIds: Array.from(new Set([...record.reviewedLessonIds, lesson.id])) })}>Finish reading the guide</button>}
      <button disabled={busy} onClick={() => choice('paused')}>Pause guide</button>
      <button disabled={busy} onClick={() => choice('skipped')}>Skip guide</button>
    </div>
  </main>;
}
const PRODUCT_GUIDE_CSS = `.product-guide{max-width:72rem;margin:0 auto;padding:clamp(1rem,4vw,3rem);overflow-wrap:anywhere;color:var(--foreground,inherit)}.product-guide p{max-width:75ch;line-height:1.6}.product-guide nav ol{display:flex;flex-wrap:wrap;gap:.5rem;padding:0;list-style:none}.product-guide nav button[aria-current]{outline:2px solid currentColor;outline-offset:2px}.product-guide ul{padding-left:1.4rem}.product-guide li{margin:.5rem 0}.product-guide-actions{display:flex;flex-wrap:wrap;gap:.75rem}.product-guide button,.product-guide summary,.product-guide a{min-height:2.75rem}.product-guide :focus-visible{outline:2px solid currentColor;outline-offset:3px}.product-guide h1:focus{outline:none}.product-guide-return{padding:.75rem}`;
