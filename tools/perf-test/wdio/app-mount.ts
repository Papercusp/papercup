/**
 * The one place this suite decides "the operator UI is up".
 *
 * WHY THIS IS SHARED (EI-18885442084466501). The wait used to be a `30_000`
 * literal copy-pasted into all four specs with an identical `timeoutMsg`. When
 * the packaged app stopped booting, all four failed the same way — and because
 * the number lived in four places, the failure read as four independent flaky
 * specs rather than one shared precondition. Nobody can tune, justify, or fix a
 * constant that exists four times.
 *
 * WHY IT ASSERTS *WHICH* SCREEN (EI-18889416741921988). The predicate used to be
 * `#root has a first child`. The onboarding screen renders into `#root` too, so
 * that predicate could not tell the operator UI from a first-run lookalike — and
 * on 2026-07-28 every packaged run had been measuring `/onboarding` while
 * reporting numbers labelled as the operator shell (`command-palette-open =
 * 24ms` against a 400ms budget, which is exactly what an empty tutorial screen
 * costs). A mount predicate that matches the wrong screen returns the SAME value
 * whether the app is healthy or the app never got past first-run: it can only
 * ever confirm, never falsify. That is not a check.
 */
import type { Browser } from "webdriverio";

/**
 * How long to wait for real app content.
 *
 * DERIVED, not guessed — and deliberately larger than it "looks like it should
 * be". The app's own `operator_boot_timeout` is **120s**
 * (papercusp-desktop/src-tauri/src/main.rs), which bounds how long it may spend
 * bringing up its operator — embedded-PG initdb plus migrations on a first boot,
 * on a box this suite shares with the rest of the fleet. A UI-mount wait shorter
 * than that cannot distinguish "slow but healthy first boot" from "never coming
 * up": it expires while the app is still legitimately working, and reports a UI
 * problem. The old 30s value could not have passed even in principle.
 *
 * The cost of being generous is now bounded twice over: `wdio.conf.ts`'s
 * installation preflight catches the STRUCTURAL failure (an app that can never
 * boot) in ~1ms before any spec runs, and a first-run landing (below) aborts in
 * seconds rather than burning the whole budget. So this timeout is only ever
 * spent on a genuinely slow boot — the case where waiting is the correct
 * behaviour.
 */
export const APP_MOUNT_TIMEOUT_MS = Number(
  process.env.PAPERCUSP_PERF_MOUNT_TIMEOUT_MS ?? 180_000,
);

/**
 * How long a first-run landing must persist before we call it terminal.
 *
 * The root route's gateway redirect is one-shot: once TanStack Router has
 * resolved `/` to `/onboarding`, nothing will navigate away on its own. Waiting
 * out the full mount timeout there buys nothing and costs 3 minutes PER SPEC, so
 * a stable first-run landing aborts early. The dwell exists only so a redirect
 * observed mid-flight cannot trip the abort.
 */
const FIRST_RUN_DWELL_MS = 5_000;

/**
 * What proves the OPERATOR shell specifically — not merely "React rendered".
 *
 * Two selectors on purpose. `data-testid="operator-shell"` is the explicit
 * contract (added to `AdvShell` alongside this change); `.pc-advshell` is the
 * class that shell has always carried, and is what a binary built BEFORE the
 * testid landed still exposes. Accepting either means this suite works against
 * the already-packaged deb without a 3-minute rebuild, and keeps working once
 * the testid ships. Drop the class arm once no pre-testid binary is in play.
 */
const OPERATOR_SHELL_SELECTOR = '[data-testid="operator-shell"], .pc-advshell';

/** Routes that are explicitly NOT the operator UI, with why landing there means. */
const NON_SHELL_ROUTES: ReadonlyArray<{ path: string; meaning: string }> = [
  {
    path: "/onboarding",
    meaning:
      "the agent-chat FIRST-RUN console — the root gateway sends you here when " +
      "GET /api/desktop/setup-wizard-state answers without a `finished_at` (a profile that " +
      "has never completed setup) OR answers non-2xx at all (see apps/operator-vite/src/routes/index.tsx)",
  },
  {
    path: "/setup",
    meaning:
      "the classic GUI setup wizard — same gateway condition as /onboarding, taken when " +
      "the ONBOARDING_AGENT_FIRST flag is off",
  },
  { path: "/login", meaning: "the sign-in surface — this instance has no authenticated session" },
  { path: "/signup", meaning: "the sign-up surface — this instance has no account" },
];

/**
 * Everything the suite knows about the document at a point in time.
 *
 * Returned by `waitForAppMount` so a later probe can be compared AGAINST the
 * mount rather than guessed about. `docToken` is the load-bearing field: it is
 * minted into `window` on first read and dies with the document, so
 * `probe.docToken !== mount.docToken` is a DEFINITIVE "the webview was
 * replaced", where `resourceEntries === 0` was only ever an inference (and one
 * that cannot distinguish a replaced document from a webview where resource
 * timing simply is not recorded — see the egress spec).
 */
export interface MountEvidence {
  url: string;
  pathname: string;
  /** Identity of THIS document. Changes iff the document was replaced. */
  docToken: string;
  /** `-1` when `#root` itself is absent — distinct from present-but-empty. */
  rootChildren: number;
  resourceEntries: number;
  shellPresent: boolean;
  readyState: string;
}

async function readDocument(browser: Browser): Promise<MountEvidence> {
  return (await browser.execute(function (shellSelector: string) {
    const w = window as unknown as { __papercusp_perf_doc__?: string };
    if (!w.__papercusp_perf_doc__) {
      w.__papercusp_perf_doc__ =
        "doc-" + String(Date.now()) + "-" + Math.random().toString(36).slice(2, 10);
    }
    const root = document.querySelector("#root");
    return {
      url: String(window.location ? window.location.href : "(no location)"),
      pathname: String(window.location ? window.location.pathname : "(no location)"),
      docToken: w.__papercusp_perf_doc__,
      rootChildren: root ? root.childElementCount : -1,
      resourceEntries: performance.getEntriesByType("resource").length,
      shellPresent: Boolean(document.querySelector(shellSelector)),
      readyState: String(document.readyState),
    };
  }, OPERATOR_SHELL_SELECTOR)) as MountEvidence;
}

/**
 * Ask the app's OWN gateway endpoint what it answers, from inside the webview.
 *
 * This is the cheap instrumentation that decides the question the landing alone
 * cannot: a 200 carrying no `finished_at` means "this instance genuinely has no
 * completed profile" (a HARNESS gap — the suite must provision one), whereas a
 * non-2xx means the gateway dumped a set-up user into first-run because its
 * backend answered badly during boot (a PRODUCT bug — `index.tsx` deliberately
 * protects the UNREACHABLE case and then falls through to first-run on a bad
 * status). Guessing between those two cost two wrong diagnoses already.
 *
 * It runs INSIDE the webview on purpose: `fetch` there is the IPC-polyfilled
 * one, so this asks over the same transport the app itself uses, and adds no
 * HTTP egress of its own. Never throws — a diagnosis that can fail is a
 * diagnosis you cannot print.
 */
async function readFirstRunGateway(browser: Browser): Promise<string> {
  try {
    await browser.execute(function () {
      const w = window as unknown as { __papercusp_perf_gate__?: unknown };
      w.__papercusp_perf_gate__ = "pending";
      void fetch("/api/desktop/setup-wizard-state", { credentials: "same-origin" })
        .then(function (r) {
          return r.text().then(function (body) {
            w.__papercusp_perf_gate__ = {
              status: r.status,
              ok: r.ok,
              body: body.slice(0, 300),
            };
          });
        })
        .catch(function (e) {
          w.__papercusp_perf_gate__ = { error: String(e) };
        });
    });
    // Poll rather than one flat pause: a local IPC round-trip is milliseconds,
    // and a wedged backend should not add 5s to an already-failing spec.
    let result: unknown = "pending";
    for (let i = 0; i < 25; i += 1) {
      result = await browser.execute(function () {
        return (window as unknown as { __papercusp_perf_gate__?: unknown }).__papercusp_perf_gate__;
      });
      if (result !== "pending") break;
      await browser.pause(200);
    }
    if (result === "pending") return "GET /api/desktop/setup-wizard-state: no answer within 5s";
    return `GET /api/desktop/setup-wizard-state → ${JSON.stringify(result)}`;
  } catch (err) {
    return `GET /api/desktop/setup-wizard-state: could not be probed (${String(err)})`;
  }
}

function describeLanding(pathname: string): string | null {
  const hit = NON_SHELL_ROUTES.find(
    (r) => pathname === r.path || pathname.startsWith(`${r.path}/`),
  );
  return hit ? hit.meaning : null;
}

function isFirstRunLanding(pathname: string): boolean {
  return describeLanding(pathname) !== null;
}

/**
 * Resolve once the OPERATOR shell is rendered — and throw, loudly and by name,
 * when the app landed anywhere else.
 *
 * Every caller must use this rather than its own predicate: a spec that waits
 * for a weaker condition can start measuring the wrong screen, and the wrong
 * screen trivially satisfies most perf and egress assertions (it does little, so
 * it is fast and makes few requests). A false green there is the most dangerous
 * result this suite can produce — and, until EI-18889416741921988, the result it
 * was actually producing.
 *
 * Returns the mount evidence so a later probe can prove it is still looking at
 * the same document.
 */
export async function waitForAppMount(browser: Browser): Promise<MountEvidence> {
  let last: MountEvidence | null = null;
  let firstRunSince: number | null = null;
  let firstRunTerminal = false;

  try {
    await browser.waitUntil(
      async () => {
        last = await readDocument(browser);
        if (last.shellPresent && last.rootChildren > 0) return true;

        // A settled first-run landing will never become the operator shell on
        // its own — abort instead of burning the full timeout in every spec.
        if (isFirstRunLanding(last.pathname)) {
          firstRunSince ??= Date.now();
          if (Date.now() - firstRunSince >= FIRST_RUN_DWELL_MS) {
            firstRunTerminal = true;
            return true; // exit the wait; the throw happens below
          }
        } else {
          firstRunSince = null;
        }
        return false;
      },
      { timeout: APP_MOUNT_TIMEOUT_MS, interval: 500, timeoutMsg: "app mount timed out" },
    );
  } catch {
    throw new Error(await mountTimeoutDiagnosis(browser, last));
  }

  if (firstRunTerminal) throw new Error(await firstRunDiagnosis(browser, last));
  return last as unknown as MountEvidence;
}

/** The app is parked on a first-run screen: say so, and say which kind. */
async function firstRunDiagnosis(browser: Browser, seen: MountEvidence | null): Promise<string> {
  const at = seen?.pathname ?? "(unknown)";
  const gateway = await readFirstRunGateway(browser);
  return (
    `the app is on the FIRST-RUN screen, not the operator UI — every measure from this run ` +
    `would be a measurement of the WRONG SCREEN.\n\n` +
    `  landed at:  ${seen?.url ?? "(unknown)"}\n` +
    `  which is:   ${describeLanding(at) ?? "not an operator surface"}\n` +
    `  #root kids: ${seen?.rootChildren ?? "?"}   (it DID render — this is not a blank page)\n` +
    `  ${gateway}\n\n` +
    `Read the gateway answer above — it decides which bug this is:\n` +
    `  • 200 with no \`finished_at\`  → this instance has no completed profile. That is correct app\n` +
    `    behaviour for a fresh install; the SUITE must provision one (or drive onboarding to\n` +
    `    completion) before it measures anything.\n` +
    `  • a non-2xx status            → a set-up user was dumped into first-run because the backend\n` +
    `    answered badly during boot. apps/operator-vite/src/routes/index.tsx deliberately protects\n` +
    `    the UNREACHABLE case (→ /adv) and then falls through to first-run on a bad STATUS. That is\n` +
    `    a product bug, not a harness gap.\n\n` +
    `(EI-18889416741921988 — the old predicate accepted this screen as "mounted", so the suite ` +
    `published perf numbers for the onboarding console labelled as the operator shell.)`
  );
}

/** Nothing usable ever rendered: the original boot-failure runbook still applies. */
async function mountTimeoutDiagnosis(
  browser: Browser,
  seen: MountEvidence | null,
): Promise<string> {
  const secs = Math.round(APP_MOUNT_TIMEOUT_MS / 1000);
  const where = seen
    ? `  last seen:  ${seen.url}\n` +
      `  #root kids: ${seen.rootChildren}${seen.rootChildren === -1 ? "   (#root itself is ABSENT)" : ""}\n` +
      `  shell:      ${seen.shellPresent ? "present" : "ABSENT"}   (${OPERATOR_SHELL_SELECTOR})\n` +
      `  readyState: ${seen.readyState}\n\n`
    : "  the webview could not be read at all\n\n";

  // Rendered something, on an operator route, but never the shell: the marker
  // is the suspect, not the boot. Worth saying — chasing a boot failure when the
  // app actually booted is the same wasted cycle this file exists to prevent.
  const markerNote =
    seen && seen.rootChildren > 0 && !seen.shellPresent && !isFirstRunLanding(seen.pathname)
      ? `The app RENDERED (${seen.rootChildren} child element(s)) on a non-first-run route, but the ` +
        `operator-shell marker never appeared. Suspect the marker, not the boot: check that AdvShell ` +
        `still carries data-testid="operator-shell" / .pc-advshell, and that this route renders it.\n\n`
      : "";

  return (
    `operator UI did not mount in ${secs}s.\n\n` +
    where +
    markerNote +
    `The app launched and WebDriver attached, so this is about what happened AFTER launch.\n` +
    `Read ~/.papercusp/logs/gui.log first — the app redirects its own stdout there, so the ` +
    `cause is usually stated outright (a sidecar it could not start, an operator that never ` +
    `became ready, the environment it fell back to). ~/.papercusp/logs/serve.log holds the ` +
    `sidecar's own output; if its mtime predates this run, no sidecar ever started.\n` +
    `(EI-18885442084466501 — this used to read as a UI/timeout problem when the real cause ` +
    `was an app built without its sidecar.)`
  );
}
