/**
 * Packaged-binary interaction-perf spec — drives the REAL "open a plan"
 * interaction (sidebar Plans face → row click → plan body rendered in Vditor)
 * and asserts the page-relative `plan-popup-open` measure against its budget.
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
import { recordInteractionMs } from "../perf-report";
import { waitForAppMount } from "../app-mount";
// Imported by PATH for the same reason app-mount.ts imports it that way: this
// runner sits outside the npm workspace set, so `@papercusp/gui-readiness` does
// not resolve here. The module is a pure function with no dependencies.
import {
  classifyInteractionMeasure,
  describeInteractionMeasureFailure,
} from "../../../../libs/generic/gui-readiness/src/interaction-measure";

const INTERACTION_NAME = "plan-popup-open";
/** Mirrors perf-marks.ts STALE_START_MS — a start older than this is discarded. */
const STALE_START_MS = 30_000;
const MEASURE_WAIT_MS = 8_000;
// Budget MIRRORS DESKTOP_PERF_BUDGETS.interactions['plan-popup-open']
// (packages/operator-core/lib/system-health/desktop-perf-budgets.ts). This runner
// is deliberately kept OUT of the npm workspace (README), so it cannot import the
// canonical constant — keep the two in sync when the budget changes.
const PLAN_POPUP_OPEN_BUDGET_MS = 1500;

describe("Packaged Papercusp desktop — plan popup open interaction", () => {
  it("opens a plan from the sidebar within the warm-render budget", async () => {
    // 1. Wait for the operator UI to mount real app content.
    await waitForAppMount(browser);

    // 2. Select the op-chat sidebar Plans face (?opcv=plans) — where the real
    //    "open a plan" interaction lives (WI-5547: the sidebar Plans view).
    await browser.execute(() => {
      const u = new URL(location.href);
      u.searchParams.set("opcv", "plans");
      history.pushState({}, "", u.pathname + u.search + u.hash);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    // 3. Wait for at least one plan row in the sidebar Plans face.
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Boolean(document.querySelector('[data-testid^="plans-pane-row-"]')),
        ),
      {
        timeout: 20_000,
        timeoutMsg:
          "no plan rows in the sidebar Plans face within 20s (is the op-chat sidebar open, and are there plans?)",
      },
    );

    // 4. The app idle-warms the Vditor/Lute stack ~600ms after the Plans face
    //    mounts (WI-5547) so the first open is WARM. Give it a beat so we measure
    //    the warm open, not the cold one-time WASM init.
    await browser.pause(1500);

    // 5. Pick a row we can actually OPEN, and measure THAT open.
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
    const candidates = await browser.execute((maxRows) => {
      return Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="plans-pane-row-"]'),
      )
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
    }, MAX_ROWS_TO_TRY);

    const attempts: string[] = [];
    let opened: { slug: string; harness: string | null } | null = null;
    let lastFailure: string | null = null;

    for (const candidate of candidates) {
      // Clear the previous attempt's measure + any dangling start, so a later
      // row can never be credited with an earlier row's timing.
      const clicked = await browser.execute(
        (name, slug) => {
          try {
            performance.clearMeasures?.(name);
            performance.clearMarks?.(`${name}:start`);
          } catch {
            /* ignore */
          }
          const row = document.querySelector<HTMLElement>(
            `[data-testid="plans-pane-row-${slug}"]`,
          );
          if (!row) return false;
          row.click();
          return true;
        },
        INTERACTION_NAME,
        candidate.slug,
      );
      if (!clicked) {
        attempts.push(`${candidate.slug}: row vanished before the click`);
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
    }

    const triggerFound = candidates.length > 0;
    const trigger = opened ??
      candidates[0] ?? { slug: null as string | null, harness: null };
    const clickedAt = Date.now();

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
    recordInteractionMs(INTERACTION_NAME, measuredMs, PLAN_POPUP_OPEN_BUDGET_MS);
    expect(measuredMs).not.toBeNull();
    expect(measuredMs as number).toBeLessThanOrEqual(PLAN_POPUP_OPEN_BUDGET_MS);
  });
});
