/**
 * Packaged-binary interaction-perf spec — drives the REAL "open a plan"
 * interaction (sidebar Plans face → row click → dashboard → Open full plan →
 * plan body rendered in Vditor) and asserts the page-relative
 * `plan-popup-open` measure against its budget.
 *
 * This is the FRESH-HARNESS half of desktop-performance-suite-2026-07-20 (P-007)
 * and the fix EI-18128922194224210 asked for: measuring this interaction by
 * driving a long-lived dev shell with ad-hoc eval is unreliable
 * (performance.now() never resets across navigations; bare import() probes lie).
 * A FRESH packaged binary + the in-app `performance.measure` the perf-marks hooks
 * emit (read via performance.getEntriesByName — page-relative, immune to the
 * eval clock) give a trustworthy warm-open time.
 *
 * Prereqs (see ../README.md): a built desktop binary, tauri-driver, and
 * WebKitWebDriver. Run: `npm test` from tools/perf-test/wdio.
 */
import { browser } from "@wdio/globals";
import { recordInteractionMs, recordMeasure } from "../perf-report";
import { APP_MOUNT_TIMEOUT_MS, waitForAppMount, waitForPackagedAppUrl } from "../app-mount";
// Imported by PATH for the same reason app-mount.ts imports it that way: this
// runner sits outside the npm workspace set, so `@papercusp/gui-readiness` does
// not resolve here. The module is a pure function with no dependencies.
import {
  classifyInteractionMeasure,
  describeInteractionMeasureFailure,
} from "../../../../libs/generic/gui-readiness/src/interaction-measure";
import { waitForMainThreadQuiet } from "../../../../libs/generic/gui-readiness/src/main-thread-quiet";

const INTERACTION_NAME = "plan-popup-open";
/** Mirrors perf-marks.ts STALE_START_MS — a start older than this is discarded. */
const STALE_START_MS = 30_000;
const MEASURE_WAIT_MS = 8_000;
const DASHBOARD_WAIT_MS = 20_000;
const PRELOAD_WAIT_MS = 30_000;
/** Emitted only after PlanDashboard's Vditor/Lute preloader really succeeds. */
const VDITOR_READY_MARK = "plan-dashboard-vditor-ready-success-v1";
/** How many sidebar rows to try before declaring the environment unmeasurable. */
const MAX_ROWS_TO_TRY = 5;
// Budget MIRRORS DESKTOP_PERF_BUDGETS.interactions['plan-popup-open']
// (packages/operator-core/lib/system-health/desktop-perf-budgets.ts). This runner
// is deliberately kept OUT of the npm workspace (README), so it cannot import the
// canonical constant — keep the two in sync when the budget changes.
const PLAN_POPUP_OPEN_BUDGET_MS = 1500;

/** Run the shared quiet primitive inside the packaged webview. */
async function waitForMainThreadQuietInPage(): Promise<void> {
  const result = (await browser.executeAsync(
    (source: string, done: (value: unknown) => void) => {
      try {
        const wait = globalThis.Function(`return (${source})`)() as () => Promise<unknown>;
        wait().then(done, (error) => done({ ok: false, error: String(error) }));
      } catch (error) {
        done({ ok: false, error: String(error) });
      }
    },
    waitForMainThreadQuiet.toString(),
  )) as { ok?: boolean; elapsedMs?: number; error?: string };

  if (result?.ok !== true) {
    throw new Error(
      `main thread did not reach the D-003 quiet precondition${
        result?.error ? `: ${result.error}` : ''
      }${typeof result?.elapsedMs === 'number' ? ` after ${Math.round(result.elapsedMs)}ms` : ''}`,
    );
  }
}

/**
 * TanStack Router patches pushState and synchronously observes the PUSH. Keep
 * its history index intact and do not dispatch a synthetic popstate: that is a
 * second, misclassified GO navigation rather than notification for this PUSH.
 */
async function spaNavigate(path: string): Promise<void> {
  await browser.execute((p) => {
    const prevState = (window.history.state ?? {}) as Record<string, unknown>;
    const prevIndex =
      typeof prevState.__TSR_index === "number" ? prevState.__TSR_index : 0;
    history.pushState({ ...prevState, __TSR_index: prevIndex + 1 }, "", p);
  }, path);
}

describe("Packaged Papercusp desktop — plan popup open interaction", () => {
  it("opens a plan from the sidebar within the warm-render budget", async () => {
    // useWorkspaceId snapshots at mount. A private packaged SPA has no HTTP
    // bootstrap injection, so an explicit fixture scope must precede that mount.
    const mountStartedAt = Date.now();
    const requestedWorkspace = process.env.PAPERCUSP_PERF_WORKSPACE_ID;
    if (requestedWorkspace) {
      const appUrl = await waitForPackagedAppUrl(browser);
      const scopedUrl = new URL(appUrl);
      scopedUrl.pathname = '/adv';
      scopedUrl.search = new URLSearchParams({ ws: requestedWorkspace, opcv: 'plans' }).toString();
      scopedUrl.hash = '';
      await browser.url(scopedUrl.toString());
    }
    // 1. Wait for the operator UI to mount real app content.
    // URL discovery and the second navigation share one mount budget.
    await waitForAppMount(browser, Math.max(1, APP_MOUNT_TIMEOUT_MS - (Date.now() - mountStartedAt)));

    // 2. Select the op-chat sidebar Plans face (?opcv=plans) — where the real
    //    "open a plan" interaction lives (WI-5547: the sidebar Plans view).
    const plansUrl = await browser.execute((requestedSlug: string | null) => {
      const u = new URL(location.href);
      u.searchParams.set("opcv", "plans");
      // The list is virtualized: a pinned row need not be in the mounted window.
      // Use its existing search control before looking for that row in the DOM.
      if (requestedSlug) u.searchParams.set("plq", requestedSlug);
      return u.pathname + u.search + u.hash;
    }, process.env.PAPERCUSP_PERF_PLAN_SLUG ?? null);
    await spaNavigate(plansUrl);

    // Compact desktop profiles can present the chat as a collapsed rail.
    // Establish the visible interaction surface before starting any timing.
    await browser.waitUntil(async () => await browser.execute(() => {
      const sidebar = document.querySelector<HTMLElement>('.op-chat-sidebar');
      if (!sidebar) return false;
      if (sidebar.dataset.collapsed === 'true') {
        sidebar.querySelector<HTMLButtonElement>('[aria-label="Expand Papercup chat"]')?.click();
        return false;
      }
      return true;
    }), { timeout: 20_000, timeoutMsg: 'Papercup chat sidebar not available' })
      .catch(() => undefined); // The diagnostic below records absent vs collapsed.

    // 3. Wait for at least one plan row in the sidebar Plans face.
    const rowsReady = await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Boolean(document.querySelector('[data-testid^="plans-pane-row-"]')),
        ),
      {
        timeout: 20_000,
        timeoutMsg:
          "no plan rows in the sidebar Plans face within 20s (is the op-chat sidebar open, and are there plans?)",
      },
    ).then(() => true, () => false);

    if (!rowsReady) {
      const transport = await browser.execute(() => {
        const metrics = (window as unknown as {
          __sync_metrics__?: {
            snapshot(): { scheduler?: unknown; byQuery?: Record<string, unknown> };
            queries(): Array<{ name: string }>;
          };
        }).__sync_metrics__;
        const snapshot = metrics?.snapshot();
        return {
          scheduler: snapshot?.scheduler ?? null,
          plans: snapshot?.byQuery?.['plans.list'] ?? null,
          recentPlans: metrics?.queries().filter((query) => query.name === 'plans.list').slice(-5) ?? [],
        };
      });
      console.log(`[perf] plan-list transport=${JSON.stringify(transport)}`);
      const snapshot = await browser.execute(() => ({
        href: location.href,
        planRowCount: document.querySelectorAll(
          '[data-testid^="plans-pane-row-"]',
        ).length,
        selectedFace: document.querySelector<HTMLElement>(
          '[aria-selected="true"], [aria-pressed="true"]',
        )?.getAttribute("aria-label") ?? null,
        sidebarText: (
          document.querySelector<HTMLElement>(".op-chat-sidebar")?.innerText ??
          document.body.innerText ??
          ""
        ).trim().slice(0, 1200),
        shellPresent: Boolean(document.querySelector('[data-testid="operator-shell"], .pc-advshell')),
        sidebarPresent: Boolean(document.querySelector('.op-chat-sidebar')),
        sidebarCollapsed: document.querySelector<HTMLElement>('.op-chat-sidebar')?.dataset.collapsed ?? null,
        alerts: Array.from(document.querySelectorAll<HTMLElement>('[role="alert"]'))
          .map((el) => el.innerText.trim().slice(0, 320)).slice(0, 3),
      }));
      throw new Error(
        "no plan rows in the sidebar Plans face within 20s after router PUSH; " +
          `sidebar snapshot=${JSON.stringify(snapshot)}`,
      );
    }

    // 4. Pick a row whose dashboard can open a real plan, and measure THAT
    //    dashboard's "Open full plan" interaction.
    //
    //    WHY THIS IS NOT "click the first row" (WI-38449). The sidebar lists
    //    plans the popup cannot load: a row whose plan resolves to `not_found`
    //    renders PlanDetail's benign "Plan not found." empty state, so Vditor
    //    never parses, `endInteraction` never fires, and no measure is ever
    //    emitted. Measured here: 4 papercusp plans exist ONLY under
    //    workspace_id='default' and every one of them answers not_found, while
    //    8/8 control plans load — so which row lands first is a property of the
    //    ENVIRONMENT, not of render performance.
    //
    //    That made this spec fail as if the interaction had regressed. An
    //    unopenable plan is a VOID SAMPLE, not a slow one: the same distinction
    //    the egress spec draws when it records -1 for a sample it declared void
    //    rather than a truthful-but-meaningless 0. So try rows in order until
    //    one genuinely opens, and measure that one; only report a perf verdict
    //    for a sample that actually measured the interaction.
    const candidates = await browser.execute(({ maxRows, requestedSlug }) => {
      return Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="plans-pane-row-"]'),
      )
        .filter((el) => !requestedSlug || el.getAttribute('data-testid') === `plans-pane-row-${requestedSlug}`)
        .slice(0, maxRows)
        .map((el) => ({
          slug: (el.getAttribute("data-testid") ?? "").replace(
            "plans-pane-row-",
            "",
          ),
          harness:
            el.querySelector(".plans-pane__row-harness")?.textContent?.trim() ??
            null,
        }));
    }, { maxRows: MAX_ROWS_TO_TRY, requestedSlug: process.env.PAPERCUSP_PERF_PLAN_SLUG ?? null });

    const attempts: string[] = [];
    let opened: { slug: string; harness: string | null } | null = null;
    let lastFailure: string | null = null;
    let triggerFound = false;
    let clickedAt = Date.now();

    for (const candidate of candidates) {
      // The August dashboard takeover changed a row click from the popup trigger
      // into navigation. Exercise that real first hop and wait for the dashboard
      // action that now owns beginInteraction(planPopupOpen).
      await waitForMainThreadQuietInPage();
      const navigated = await browser.execute(
        (slug) => {
          const row = document.querySelector<HTMLElement>(
            `[data-testid="plans-pane-row-${slug}"]`,
          );
          if (!row) return false;
          row.click();
          return true;
        },
        candidate.slug,
      );
      if (!navigated) {
        lastFailure = "row vanished before dashboard navigation";
        attempts.push(`${candidate.slug}: ${lastFailure}`);
        continue;
      }

      const dashboardReady = await browser
        .waitUntil(
          async () =>
            await browser.execute(() =>
              Boolean(document.querySelector('[data-testid="plan-dash-open-full"]')),
            ),
          { timeout: DASHBOARD_WAIT_MS, timeoutMsg: "dashboard action not rendered" },
        )
        .then(() => true, () => false);
      if (!dashboardReady) {
        lastFailure = "dashboard action not rendered";
        attempts.push(`${candidate.slug} [${candidate.harness ?? "?"}]: ${lastFailure}`);
        continue;
      }

      // A fixed delay used to call this sample warm even when the best-effort
      // preloader had failed. The truth-gated mark proves JS + CSS + Lute have
      // actually completed before the timed click. A miss is an invalid warm
      // precondition, not a slow popup verdict; try another dashboard so the
      // preloader's retry path gets a chance to recover.
      const warmed = await browser
        .waitUntil(
          async () =>
            await browser.execute(
              (mark) => performance.getEntriesByName(mark, "mark").length > 0,
              VDITOR_READY_MARK,
            ),
          { timeout: PRELOAD_WAIT_MS, timeoutMsg: "Vditor warm-up did not succeed" },
        )
        .then(() => true, () => false);
      if (!warmed) {
        lastFailure = "Vditor warm-up did not succeed";
        attempts.push(`${candidate.slug} [${candidate.harness ?? "?"}]: ${lastFailure}`);
        await browser
          .execute(() => {
            document.querySelector<HTMLElement>('[data-testid="plan-dash-back"]')?.click();
          })
          .catch(() => undefined);
        await browser.pause(250);
        continue;
      }

      await waitForMainThreadQuietInPage();

      // Reuse the live scheduler's public metrics; a quiet JS thread can still
      // have queued network work. This is diagnostic, never a budget override.
      const schedulerBefore = await browser.execute(() => {
        const metrics = (window as unknown as {
          __sync_metrics__?: { snapshot(): { scheduler?: unknown } };
        }).__sync_metrics__;
        return metrics?.snapshot().scheduler ?? null;
      });
      console.log('[perf] plan-popup scheduler before click', JSON.stringify(schedulerBefore));

      if (process.env.PAPERCUSP_PERF_MICROTASK_DIAGNOSTIC === '1') {
        await browser.execute((name) => {
          const original = performance.measure;
          performance.measure = function (...args: Parameters<Performance['measure']>) {
            const result = original.apply(this, args);
            if (args[0] === `${name}:phase:content-ready`) {
              performance.measure = original;
              queueMicrotask(() => original.call(performance, `${name}:phase:content-microtask`, `${name}:start`));
            }
            return result;
          };
        }, INTERACTION_NAME);
      }

      if (process.env.PAPERCUSP_PERF_LAYOUT_DIAGNOSTIC === '1') {
        await browser.execute(() => {
          type Gap = { from: number; to: number; delayMs: number };
          const previous = (window as unknown as { __perfEventLoopProbe?: { stop(): unknown } }).__perfEventLoopProbe;
          previous?.stop();
          const gaps: Gap[] = [];
          let lastTick = performance.now();
          const timer = window.setInterval(() => {
            const now = performance.now();
            const delayMs = Math.max(0, now - lastTick - 20);
            if (delayMs >= 30) gaps.push({ from: lastTick, to: now, delayMs });
            lastTick = now;
          }, 20);
          const longTasks: Array<{ at: number; durationMs: number; name: string }> = [];
          const supportsLongTasks = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
          let observer: PerformanceObserver | null = null;
          if (supportsLongTasks) {
            try {
              observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                  longTasks.push({ at: entry.startTime, durationMs: entry.duration, name: entry.name });
                }
              });
              observer.observe({ entryTypes: ['longtask'] });
            } catch { observer = null; }
          }
          (window as unknown as { __perfEventLoopProbe: { stop(): {
            gaps: Gap[]; longTasks: typeof longTasks; supportsLongTasks: boolean;
          } } }).__perfEventLoopProbe = {
            stop: () => {
              window.clearInterval(timer);
              observer?.disconnect();
              return { gaps, longTasks, supportsLongTasks: observer !== null };
            },
          };
          const records: Array<{ api: string; ms: number; at: number; stack?: string }> = [];
          const restores: Array<() => void> = [];
          const observe = (proto: object, key: string) => {
            const descriptor = Object.getOwnPropertyDescriptor(proto, key);
            if (!descriptor?.configurable) return;
            const fn = descriptor.get ?? descriptor.value;
            if (typeof fn !== 'function') return;
            const wrapped = function (this: unknown, ...args: unknown[]) {
              const at = performance.now();
              try { return fn.apply(this, args); }
              finally {
                const ms = performance.now() - at;
                if (ms >= 10) records.push({ api: key, ms, at, stack: new Error().stack?.slice(0, 1600) });
              }
            };
            Object.defineProperty(proto, key, descriptor.get ? { ...descriptor, get: wrapped } : { ...descriptor, value: wrapped });
            restores.push(() => Object.defineProperty(proto, key, descriptor));
          };
          for (const key of ['getBoundingClientRect', 'getClientRects', 'scrollIntoView', 'clientWidth', 'clientHeight', 'scrollHeight']) observe(Element.prototype, key);
          for (const key of ['offsetWidth', 'offsetHeight', 'focus', 'innerText']) observe(HTMLElement.prototype, key);
          (window as unknown as { __perfLayoutProbe: { records: typeof records; restore(): void } }).__perfLayoutProbe = {
            records, restore: () => restores.forEach((restore) => restore()),
          };
        });
      }

      if (process.env.PAPERCUSP_PERF_REACT_MODULE) {
        const installed = await browser.executeAsync((url: string, done: (value: unknown) => void) => {
          const load = new Function('url', 'return import(url)') as (url: string) => Promise<{ t(): Record<string, Function> }>;
          load(url).then((module) => {
            const react = module.t();
            const records: Array<{ hook: string; ms: number; at: number; stack?: string }> = [];
            const restore: Array<() => void> = [];
            for (const hook of ['useEffect', 'useLayoutEffect', 'useInsertionEffect']) {
              const original = react[hook];
              if (typeof original !== 'function') continue;
              react[hook] = function (effect: () => unknown, deps: unknown) {
                const stack = new Error().stack?.slice(0, 1800);
                return original.call(react, () => {
                  const at = performance.now();
                  try { return effect(); }
                  finally {
                    const ms = performance.now() - at;
                    if (ms >= 5) records.push({ hook, ms, at, stack });
                  }
                }, deps);
              };
              restore.push(() => { react[hook] = original; });
            }
            (window as unknown as { __perfReactProbe: { records: typeof records; restore(): void } }).__perfReactProbe = {
              records, restore: () => restore.forEach((fn) => fn()),
            };
            done({ installed: true });
          }).catch((error) => done({ error: String(error) }));
        }, process.env.PAPERCUSP_PERF_REACT_MODULE);
        console.log('[perf] React effect probe', JSON.stringify(installed));
      }

      // Clear the previous attempt's measure + any dangling start immediately
      // before the CURRENT trigger, so a later plan can never be credited with
      // an earlier plan's timing.
      clickedAt = Date.now();
      const clicked = await browser.execute((name) => {
        try {
          performance.clearMeasures?.(name);
          performance.clearMarks?.(`${name}:start`);
        } catch {
          /* ignore */
        }
        const trigger = document.querySelector<HTMLElement>(
          '[data-testid="plan-dash-open-full"]',
        );
        if (!trigger) return false;
        trigger.click();
        performance.mark(`${name}:trigger-return`);
        return true;
      }, INTERACTION_NAME);
      triggerFound ||= clicked;
      if (!clicked) {
        lastFailure = "dashboard action vanished before the click";
        attempts.push(`${candidate.slug} [${candidate.harness ?? "?"}]: ${lastFailure}`);
        continue;
      }

      // Settle to one of three terminal states rather than only "measure
      // appeared": a plan that cannot load reaches its empty state fast, and
      // waiting the full budget for it would turn an environment fact into an
      // 8s stall per row.
      const outcome = await browser.waitUntil(
        async () =>
          await browser.execute((name) => {
            if (performance.getEntriesByName(name, "measure").length > 0)
              return "measured";
            const surface = document.querySelector<HTMLElement>(
              '[data-testid="plan-popup-body"]',
            );
            const placeholder =
              surface?.querySelector<HTMLElement>(".pc-plans__placeholder") ??
              null;
            const text = (placeholder?.textContent ?? "").trim();
            // "Loading …" is in-flight; any OTHER placeholder is terminal
            // (not-found / server error / no data) and this sample is void.
            if (placeholder && text && !/^Loading\b/i.test(text))
              return `void:${text.slice(0, 120)}`;
            return false as const;
          }, INTERACTION_NAME),
        {
          timeout: MEASURE_WAIT_MS,
          timeoutMsg: "pending",
        },
      ).catch(() => "timeout" as const);

      if (outcome === "measured") {
        opened = candidate;
        break;
      }

      const unfinished = await browser.execute((name) => {
        const metrics = (window as unknown as {
          __sync_metrics__?: { snapshot(): { scheduler?: unknown } };
        }).__sync_metrics__;
        return {
          scheduler: metrics?.snapshot().scheduler ?? null,
          phases: performance.getEntriesByType('measure')
            .filter((entry) => entry.name.startsWith(`${name}:phase:`))
            .map((entry) => ({ name: entry.name, ms: Math.round(entry.duration) })),
          placeholder: document.querySelector('[data-testid="plan-popup-body"] .pc-plans__placeholder')?.textContent?.trim() ?? null,
        };
      }, INTERACTION_NAME);
      console.log('[perf] plan-popup unfinished', JSON.stringify({ outcome, ...unfinished }));

      if (process.env.PAPERCUSP_PERF_LAYOUT_DIAGNOSTIC === '1') {
        await browser.execute(() => {
          (window as unknown as { __perfLayoutProbe?: { restore(): void } }).__perfLayoutProbe?.restore();
          (window as unknown as { __perfEventLoopProbe?: { stop(): unknown } }).__perfEventLoopProbe?.stop();
        }).catch(() => undefined);
      }

      lastFailure = String(outcome);
      attempts.push(
        `${candidate.slug} [${candidate.harness ?? "?"}]: ${String(outcome)}`,
      );
      // Close the popup so the next row starts from the same clean state.
      await browser
        .execute(() => {
          document
            .querySelector<HTMLElement>('[data-testid="plan-popup-close"]')
            ?.click();
        })
        .catch(() => undefined);
      await browser.pause(250);
      // Narrow/sidebar layout replaces the list with the dashboard. Return to
      // the list before trying the next candidate; in split layout this simply
      // clears the selected dashboard and leaves the already-visible rows.
      await browser
        .execute(() => {
          document.querySelector<HTMLElement>('[data-testid="plan-dash-back"]')?.click();
        })
        .catch(() => undefined);
      await browser
        .waitUntil(
          async () =>
            await browser.execute((slug) =>
              Boolean(document.querySelector(`[data-testid="plans-pane-row-${slug}"]`)),
              candidate.slug,
            ),
          { timeout: DASHBOARD_WAIT_MS, timeoutMsg: "plan list did not return" },
        )
        .catch(() => undefined);
    }

    const trigger = opened ??
      candidates[0] ?? { slug: null as string | null, harness: null };

    // 6. Wait for the measure to be emitted (endInteraction fires when the plan
    //    body renders in Vditor), then read it.
    //
    //    ON TIMEOUT, NAME THE CAUSE — do not restate the symptom. "No measure in
    //    8s" is emitted identically whether the click missed, the popup never
    //    opened, the body never loaded, or the settle hook is simply absent from
    //    this mount context; those are four different bugs in four different
    //    components. The classifier decides which, from what the page shows at
    //    the moment the wait expires. (Same fix shape as the web-vitals
    //    instrument's injected-instrument classifier.)
    //
    //    UNMEASURABLE ≠ SLOW. If no row opened at all, this run never exercised
    //    the interaction, so it has NOTHING to say about its speed. Fail loudly
    //    on the precondition and publish no number — a void sample must never be
    //    recorded as a timing, and must never read as a perf regression.
    if (!opened) {
      throw new Error(
        [
          `UNMEASURABLE: no dashboard plan opened from the first ${candidates.length} sidebar row(s) — ` +
            `this run never exercised "${INTERACTION_NAME}", so it is NOT a perf verdict`,
          `last outcome: ${lastFailure ?? "(no rows to try)"}`,
          ...attempts.map((a) => `  tried ${a}`),
          `the timed trigger is PlanDashboard's "Open full plan" action; the row click only navigates.`,
          `A plan whose plans:get answers not_found renders PlanDetail's "Plan not found." empty state,`,
          `so Vditor never parses and endInteraction never fires. Check that the sidebar's plan`,
          `LIST and plans:get agree on workspace scope for these slugs.`,
        ].join("\n  "),
      );
    }

    try {
      await browser.waitUntil(
        async () =>
          await browser.execute(
            (name) => performance.getEntriesByName(name, "measure").length > 0,
            INTERACTION_NAME,
          ),
        {
          timeout: MEASURE_WAIT_MS,
          timeoutMsg: `no "${INTERACTION_NAME}" measure emitted within ${MEASURE_WAIT_MS}ms of the click`,
        },
      );
    } catch (waitError) {
      const snapshot = await browser.execute((name) => {
        const startName = `${name}:start`;
        const marks = performance.getEntriesByName(startName, "mark");
        const start = marks[marks.length - 1];
        // The popup body PlanPopupModal renders; PlanDetail mounts inside it.
        const surface = document.querySelector<HTMLElement>(
          '[data-testid="plan-popup-body"]',
        );
        // PlanDetail shows a `.pc-plans__placeholder` while loading or on error,
        // and Vditor's preview renders into `.vditor-reset` once the body parses.
        const placeholder =
          surface?.querySelector<HTMLElement>(".pc-plans__placeholder") ?? null;
        const rendered = surface?.querySelector(".vditor-reset") ?? null;
        return {
          measureCount: performance.getEntriesByName(name, "measure").length,
          startMarkPresent: Boolean(start),
          startMarkAgeMs: start ? performance.now() - start.startTime : null,
          surfacePresent: Boolean(surface),
          contentPresent: Boolean(rendered) && !placeholder,
          placeholderText: placeholder
            ? (placeholder.textContent ?? "").trim().slice(0, 200)
            : null,
          modalPresent: Boolean(document.querySelector(".plan-popup")),
        };
      }, INTERACTION_NAME);

      const diagnosis = classifyInteractionMeasure({
        measureCount: snapshot.measureCount,
        startMarkPresent: snapshot.startMarkPresent,
        startMarkAgeMs: snapshot.startMarkAgeMs,
        staleStartMs: STALE_START_MS,
        triggerFound,
        settleSurfacePresent: snapshot.surfacePresent,
        settleContentPresent: snapshot.contentPresent,
        elapsedMs: Date.now() - clickedAt,
      });

      const observed = [
        `observed: trigger=${triggerFound}`,
        `clickedPlan=${trigger.slug ?? "(none)"}`,
        `rowHarness=${trigger.harness ?? "(none)"}`,
        `startMark=${snapshot.startMarkPresent}`,
        `modal=${snapshot.modalPresent}`,
        `body=${snapshot.surfacePresent}`,
        `content=${snapshot.contentPresent}`,
        snapshot.placeholderText
          ? `placeholder=${JSON.stringify(snapshot.placeholderText)}`
          : null,
      ]
        .filter(Boolean)
        .join(" ");

      throw new Error(
        `${describeInteractionMeasureFailure(
          INTERACTION_NAME,
          MEASURE_WAIT_MS,
          diagnosis,
        )}\n  ${observed}\n  (wait: ${(waitError as Error).message})`,
      );
    }

    const measuredMs = await browser.execute((name) => {
      const entries = performance.getEntriesByName(name, "measure");
      return entries.length
        ? Math.round(entries[entries.length - 1].duration)
        : null;
    }, INTERACTION_NAME);

    // Record BEFORE the asserts — `expect` throws on a breach, and a breach is
    // exactly the observation the release gate exists to catch.
    const phases = await browser.execute((name) =>
      performance.getEntriesByType('measure')
        .filter((entry) => entry.name.startsWith(`${name}:phase:`))
        .map((entry) => ({ key: entry.name, value: Math.round(entry.duration) })),
      INTERACTION_NAME,
    );
    // The ledger stamps invocation time at dispatch settlement. The page's
    // completed interaction measure retains its startTime after endInteraction
    // consumes the :start mark, so use the measure to correlate those records.
    const startWallMs = await browser.execute((name) => {
      const measure = performance.getEntriesByName(name, 'measure').at(-1);
      return measure ? Math.round(performance.timeOrigin + measure.startTime) : null;
    }, INTERACTION_NAME);
    console.log('[perf] plan-popup start wall time', startWallMs === null ? 'missing' : new Date(startWallMs).toISOString());
    console.log('[perf] plan-popup phases (cumulative click-to-phase ms)', JSON.stringify(phases));
    if (process.env.PAPERCUSP_PERF_REACT_MODULE) {
      const effects = await browser.execute(() => {
        const probe = (window as unknown as { __perfReactProbe?: { records: unknown[]; restore(): void } }).__perfReactProbe;
        probe?.restore();
        return probe?.records ?? [];
      });
      console.log('[perf] React effects', JSON.stringify(effects));
    }
    if (process.env.PAPERCUSP_PERF_LAYOUT_DIAGNOSTIC === '1') {
      const diagnostics = await browser.execute((name) => {
        const probe = (window as unknown as { __perfLayoutProbe?: { records: unknown[]; restore(): void } }).__perfLayoutProbe;
        probe?.restore();
        const interaction = performance.getEntriesByName(name, 'measure').at(-1);
        const triggerReturn = performance.getEntriesByName(`${name}:trigger-return`, 'mark').at(-1);
        const probeResult = (window as unknown as {
          __perfEventLoopProbe?: { stop(): {
            gaps: Array<{ from: number; to: number; delayMs: number }>;
            longTasks: Array<{ at: number; durationMs: number; name: string }>;
            supportsLongTasks: boolean;
          } };
        }).__perfEventLoopProbe?.stop();
        return {
          layout: probe?.records ?? [],
          supportsLongTasks: probeResult?.supportsLongTasks ?? false,
          visibility: document.visibilityState,
          triggerReturnMs: interaction && triggerReturn
            ? Math.round(triggerReturn.startTime - interaction.startTime)
            : null,
          idleGaps: interaction
            ? (probeResult?.gaps ?? [])
              .filter((gap) => gap.to < interaction.startTime)
              .slice(-5)
              .map((gap) => Math.round(gap.delayMs))
            : [],
          gaps: interaction
            ? (probeResult?.gaps ?? [])
              .filter((gap) => gap.to >= interaction.startTime && gap.from <= interaction.startTime + interaction.duration)
              .map((gap) => ({
                fromMs: Math.round(gap.from - interaction.startTime),
                toMs: Math.round(gap.to - interaction.startTime),
                delayMs: Math.round(gap.delayMs),
              }))
            : [],
          longTasks: interaction
            ? (probeResult?.longTasks ?? [])
              .filter((task) => task.at <= interaction.startTime + interaction.duration &&
                task.at + task.durationMs >= interaction.startTime)
              .map((task) => ({ atMs: Math.round(task.at - interaction.startTime),
                durationMs: Math.round(task.durationMs), name: task.name }))
            : [],
        };
      }, INTERACTION_NAME);
      console.log('[perf] layout operations', JSON.stringify(diagnostics.layout));
      console.log('[perf] event loop gaps', JSON.stringify({
        gaps: diagnostics.gaps, longTasks: diagnostics.longTasks,
        supportsLongTasks: diagnostics.supportsLongTasks,
        triggerReturnMs: diagnostics.triggerReturnMs,
        idleGaps: diagnostics.idleGaps,
        visibility: diagnostics.visibility,
      }));
    }
    for (const phase of (process.env.PAPERCUSP_PERF_REQUIRED_PHASES ?? '').split(',').filter(Boolean)) {
      if (!phases.some((entry) => entry.key === `${INTERACTION_NAME}:phase:${phase}`)) {
        throw new Error(`UNMEASURABLE: required phase ${phase} is missing; verify the SPA actually loaded by this native artifact`);
      }
    }
    recordInteractionMs(INTERACTION_NAME, measuredMs, PLAN_POPUP_OPEN_BUDGET_MS);
    const resources = await browser.execute((name) => {
      const measure = performance.getEntriesByName(name, 'measure').at(-1);
      if (!measure) return [];
      return (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
        .filter((entry) => entry.startTime >= measure.startTime && entry.startTime < measure.startTime + measure.duration)
        .map((entry) => ({
          path: new URL(entry.name, location.href).pathname,
          startMs: Math.round(entry.startTime - measure.startTime),
          durationMs: Math.round(entry.duration),
        }));
    }, INTERACTION_NAME);
    console.log('[perf] plan-popup scenario and resources', JSON.stringify({ opened, resources }));
    const schedulerAfter = await browser.execute(() => {
      const metrics = (window as unknown as {
        __sync_metrics__?: { snapshot(): { scheduler?: unknown } };
      }).__sync_metrics__;
      return metrics?.snapshot().scheduler ?? null;
    });
    console.log('[perf] plan-popup scheduler after render', JSON.stringify(schedulerAfter));
    for (const phase of phases) {
      recordMeasure({ ...phase, unit: 'ms', budget: null, ok: true });
    }
    if (startWallMs === null) {
      throw new Error('UNMEASURABLE: completed plan-popup measure lost its absolute start time');
    }
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(PLAN_POPUP_OPEN_BUDGET_MS);
  });
});
