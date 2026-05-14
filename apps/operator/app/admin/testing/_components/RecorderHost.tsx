'use client';

/**
 * RecorderHost — mounted in the root layout when ?perf-recorder=1 is set.
 *
 * Listens on the BroadcastChannel for a `start` message from the
 * controller window, then dynamically loads Gremlins.js and runs it in
 * the recorder window. Posts back per-click events + a final summary
 * over the same channel.
 *
 * Why a separate window instead of an iframe: keeps the controller UI
 * alive while the app navigates underneath, but avoids the same-origin
 * gymnastics + double-React-tree memory cost of iframing the app.
 */

import { useEffect } from 'react';
import { CHANNEL_NAME, type ControllerMsg, type RecorderMsg, type RecorderEvent, type RunSummary, rollupRoutes } from '../_lib/recorder-channel';

declare global {
  interface Window { __papercuspRecorderActive?: boolean }
}

interface Gremlins {
  createHorde(opts: { strategies?: unknown[]; mogwais?: unknown[]; before?: () => Promise<void> }): {
    gremlin(g: unknown): unknown;
    mogwai(m: unknown): unknown;
    strategy(s: unknown): unknown;
    seed(s: number): unknown;
    unleash(opts?: { nb: number }): Promise<void>;
    stop(): void;
  };
  strategies: { distribution(opts: { delay?: number; nb?: number }): unknown };
  mogwais: {
    alert(): unknown;
    fps(): unknown;
    gizmo(opts: { maxErrors?: number }): unknown;
  };
}

export default function RecorderHost() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('perf-recorder') !== '1') return;
    if (window.__papercuspRecorderActive) return;
    window.__papercuspRecorderActive = true;

    const channel = new BroadcastChannel(CHANNEL_NAME);
    let currentRunId: string | null = null;
    let runEvents: RecorderEvent[] = [];
    let clickCount = 0;
    let startedAt = 0;
    let stopRun: (() => void) | null = null;

    function send(msg: RecorderMsg) {
      channel.postMessage(msg);
    }

    function describe(node: EventTarget | null): string {
      if (!(node instanceof Element)) return '(unknown)';
      const role = node.getAttribute('role');
      const aria = node.getAttribute('aria-label');
      const text = (node.textContent ?? '').trim().slice(0, 40);
      const tag = node.tagName.toLowerCase();
      if (aria) return `${tag}[aria-label="${aria}"]`;
      if (text) return `${tag} "${text}"`;
      if (role) return `${tag}[role=${role}]`;
      return tag;
    }

    function recordEvent(e: RecorderEvent) {
      runEvents.push(e);
      send({ type: 'event', runId: currentRunId!, event: e });
    }

    function setupObservers(): () => void {
      const obs: PerformanceObserver[] = [];
      try {
        const intObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const ev = entry as PerformanceEventTiming;
            if (ev.duration < 40) continue;
            recordEvent({
              ts: Date.now(),
              route: window.location.pathname,
              kind: 'click',
              target: describe(ev.target ?? null),
              inp: Math.round(ev.duration),
            });
            clickCount++;
            send({ type: 'progress', runId: currentRunId!, clicks: clickCount, elapsedMs: Date.now() - startedAt });
          }
        });
        intObs.observe({ type: 'event', durationThreshold: 40, buffered: false } as PerformanceObserverInit);
        obs.push(intObs);
      } catch { /* not supported */ }

      try {
        const ltObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            recordEvent({
              ts: Date.now(),
              route: window.location.pathname,
              kind: 'long-task',
              target: 'main-thread',
              duration: Math.round(entry.duration),
            });
          }
        });
        ltObs.observe({ type: 'longtask', buffered: false } as PerformanceObserverInit);
        obs.push(ltObs);
      } catch { /* not supported */ }

      try {
        const lsObs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const ls = entry as PerformanceEntry & { value: number; hadRecentInput?: boolean };
            if (ls.hadRecentInput || ls.value < 0.01) continue;
            recordEvent({
              ts: Date.now(),
              route: window.location.pathname,
              kind: 'layout-shift',
              target: 'viewport',
              duration: Math.round(ls.value * 1000),
            });
          }
        });
        lsObs.observe({ type: 'layout-shift', buffered: false } as PerformanceObserverInit);
        obs.push(lsObs);
      } catch { /* not supported */ }

      const origErr = console.error;
      console.error = (...args: unknown[]) => {
        origErr(...args);
        recordEvent({
          ts: Date.now(),
          route: window.location.pathname,
          kind: 'console-error',
          target: 'console',
          detail: args.map((a) => (typeof a === 'string' ? a : (a as Error)?.message ?? String(a))).join(' ').slice(0, 200),
        });
      };
      const onErr = (e: ErrorEvent) => {
        recordEvent({ ts: Date.now(), route: window.location.pathname, kind: 'unhandled-error', target: e.filename ?? 'window', detail: (e.message ?? '').slice(0, 200) });
      };
      const onRej = (e: PromiseRejectionEvent) => {
        recordEvent({ ts: Date.now(), route: window.location.pathname, kind: 'unhandled-error', target: 'promise', detail: String(e.reason).slice(0, 200) });
      };
      window.addEventListener('error', onErr);
      window.addEventListener('unhandledrejection', onRej);

      return () => {
        obs.forEach((o) => o.disconnect());
        console.error = origErr;
        window.removeEventListener('error', onErr);
        window.removeEventListener('unhandledrejection', onRej);
      };
    }

    function isBlocked(node: Element, blocklist: string[]): boolean {
      const text = `${node.getAttribute('aria-label') ?? ''} ${node.textContent ?? ''}`.toLowerCase();
      return blocklist.some((b) => b && text.includes(b.toLowerCase()));
    }

    async function startRun(msg: Extract<ControllerMsg, { type: 'start' }>) {
      currentRunId = msg.runId;
      runEvents = [];
      clickCount = 0;
      startedAt = Date.now();
      send({ type: 'started', runId: currentRunId });

      const teardown = setupObservers();

      // Dynamic import gremlins.js — keeps it out of the main app bundle.
      let gremlins: Gremlins | null = null;
      try {
        const mod = await import('gremlins.js');
        gremlins = (mod as unknown as { default: Gremlins }).default ?? (mod as unknown as Gremlins);
      } catch (err) {
        recordEvent({ ts: Date.now(), route: window.location.pathname, kind: 'unhandled-error', target: 'gremlins-import', detail: String(err).slice(0, 200) });
      }

      let horde: ReturnType<Gremlins['createHorde']> | null = null;
      if (gremlins && !msg.dryRun) {
        // Filter out elements matching the blocklist before each gremlin tick.
        // Gremlins doesn't expose pre-click hooks, so we tag blocked elements
        // with pointer-events:none for the duration of the run.
        const blocked = new Set<Element>();
        const tagBlocked = () => {
          document.querySelectorAll('button, [role="button"], a, [role="tab"], [role="menuitem"], [role="switch"]').forEach((el) => {
            if (isBlocked(el, msg.blocklist) && !blocked.has(el)) {
              blocked.add(el);
              (el as HTMLElement).dataset.perfBlocked = '1';
            }
          });
        };
        tagBlocked();
        const mutObs = new MutationObserver(tagBlocked);
        mutObs.observe(document.body, { childList: true, subtree: true });

        // Inject CSS to neuter blocked elements.
        const style = document.createElement('style');
        style.textContent = '[data-perf-blocked="1"] { pointer-events: none !important; }';
        document.head.appendChild(style);

        horde = gremlins.createHorde({
          strategies: [gremlins.strategies.distribution({ delay: 50 })],
          mogwais: [gremlins.mogwais.alert(), gremlins.mogwais.fps(), gremlins.mogwais.gizmo({ maxErrors: 50 })],
        });

        stopRun = () => {
          horde?.stop();
          mutObs.disconnect();
          style.remove();
          blocked.forEach((el) => delete (el as HTMLElement).dataset.perfBlocked);
        };

        horde.unleash({ nb: Math.floor(msg.durationMs / 50) }).catch(() => { /* horde aborted */ });
      }

      // Stop after durationMs even if horde is still running or in dry-run.
      const timer = setTimeout(() => finishRun(), msg.durationMs);

      function finishRun() {
        clearTimeout(timer);
        stopRun?.();
        stopRun = null;
        teardown();
        const summary: RunSummary = {
          runId: currentRunId!,
          startedAt,
          endedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          clicks: clickCount,
          events: runEvents,
          routes: rollupRoutes(runEvents),
        };
        send({ type: 'done', runId: currentRunId!, summary });
        currentRunId = null;
      }

      // Allow controller to stop early.
      channel.addEventListener('message', (e) => {
        const m = e.data as ControllerMsg;
        if (m.type === 'stop' && m.runId === currentRunId) finishRun();
      });
    }

    channel.addEventListener('message', (e) => {
      const m = e.data as ControllerMsg;
      if (m.type === 'start') void startRun(m);
    });

    send({ type: 'ready', runId: '' });

    return () => {
      channel.close();
      stopRun?.();
    };
  }, []);

  return null;
}
