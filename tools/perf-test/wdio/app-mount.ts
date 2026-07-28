/**
 * The one place this suite decides "the operator UI is up".
 *
 * WHY THIS IS SHARED (EI-18885442084466501). The wait used to be a `30_000`
 * literal copy-pasted into all four specs with an identical `timeoutMsg`. When
 * the packaged app stopped booting, all four failed the same way — and because
 * the number lived in four places, the failure read as four independent flaky
 * specs rather than one shared precondition. Nobody can tune, justify, or fix a
 * constant that exists four times.
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
 * The cost of being generous is now bounded, because `wdio.conf.ts`'s
 * installation preflight catches the STRUCTURAL failure (an app that can never
 * boot) in ~1ms, before any spec runs. So this timeout is only ever spent on a
 * genuinely slow boot — the case where waiting is the correct behaviour.
 *
 * Refine it with a measured distribution of cold packaged first-paint times once
 * the suite runs green; until then it is anchored to the app's own contract
 * rather than to a number someone liked the look of.
 */
export const APP_MOUNT_TIMEOUT_MS = Number(
  process.env.PAPERCUSP_PERF_MOUNT_TIMEOUT_MS ?? 180_000,
);

/**
 * Resolve once `#root` has real content.
 *
 * `#root` itself exists in the shipped HTML, so its presence proves nothing —
 * only a FIRST CHILD means React actually rendered. Every caller must use this
 * rather than its own predicate: a spec that waits for a weaker condition can
 * start measuring an empty page, and an empty page trivially satisfies most perf
 * and egress assertions (it does nothing, so it is fast and makes no requests).
 * A false green there is the most dangerous result this suite can produce.
 */
export async function waitForAppMount(browser: Browser): Promise<void> {
  await browser.waitUntil(
    async () =>
      await browser.execute(() => Boolean(document.querySelector("#root")?.firstElementChild)),
    {
      timeout: APP_MOUNT_TIMEOUT_MS,
      timeoutMsg:
        `operator UI did not mount in ${Math.round(APP_MOUNT_TIMEOUT_MS / 1000)}s.\n\n` +
        `The app launched and WebDriver attached, so this is about what happened AFTER launch.\n` +
        `Read ~/.papercusp/logs/gui.log first — the app redirects its own stdout there, so the ` +
        `cause is usually stated outright (a sidecar it could not start, an operator that never ` +
        `became ready, the environment it fell back to). ~/.papercusp/logs/serve.log holds the ` +
        `sidecar's own output; if its mtime predates this run, no sidecar ever started.\n` +
        `(EI-18885442084466501 — this used to read as a UI/timeout problem when the real cause ` +
        `was an app built without its sidecar.)`,
    },
  );
}
