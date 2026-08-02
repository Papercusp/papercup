'use client';

/**
 * desktop-window-fullscreen — "fill the DISPLAY", for the Tauri desktop shell.
 *
 * WHY THIS EXISTS
 * ---------------
 * The DOM Fullscreen API (`element.requestFullscreen()`) is the right answer in
 * a BROWSER: the UA takes the OS window fullscreen and paints that element on
 * it. Inside the Tauri desktop shell it is NOT — the webview is a widget inside
 * a window we own, and the embedder decides whether a fullscreen request
 * escapes to the window manager. In practice it does not: the element grows to
 * fill the WEBVIEW, which is exactly the same pixels a "fill the app window"
 * layout mode already produces.
 *
 * That is the bug this module fixes. [owner 2026-08-02] "both fullscreen
 * buttons do the same thing. one of them is supposed to full screen on the full
 * desktop display not just the window" — the full-screen control was landing on
 * the same rectangle as the full-window control because the only mechanism it
 * had was the DOM API, which cannot leave the window here.
 *
 * The desktop answer is to drive the WINDOW: `getCurrentWindow().setFullscreen`
 * puts the OS window on the whole display, and the caller's own maximized
 * layout then fills it. Two mechanisms, one meaning — see `SessionChatModal`'s
 * `toggleScreen`, which picks between them on `isDesktopShell()`.
 *
 * OWNERSHIP (why `owned` is in the return type)
 * ---------------------------------------------
 * The window is shared with the rest of the app and with the user, who may have
 * fullscreened it themselves before opening the surface that calls this. Taking
 * it out of fullscreen on the way back would then undo something we never did.
 * `enterDesktopWindowFullscreen()` reports whether it was the one that CHANGED
 * the window, so a caller can leave a pre-existing fullscreen alone.
 *
 * Everything here is soft-fail: a browser session, an older desktop binary
 * whose baked capabilities lack `core:window:allow-set-fullscreen`, or a
 * missing `@tauri-apps/api` all resolve to "did not take effect" rather than
 * throwing, so the caller can fall back to its window-sized mode instead of
 * presenting a dead control.
 */

/** Is this webview the Tauri desktop shell (rather than a browser tab)? */
export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

/** The slice of `@tauri-apps/api/window`'s Window we use. Declared structurally
 *  so this module never has to import the type (and so tests can stub it). */
interface DesktopWindowHandle {
  setFullscreen(fullscreen: boolean): Promise<void>;
  isFullscreen(): Promise<boolean>;
}

async function currentWindow(): Promise<DesktopWindowHandle | null> {
  if (!isDesktopShell()) return null;
  try {
    const mod = (await import('@tauri-apps/api/window')) as unknown as {
      getCurrentWindow?: () => DesktopWindowHandle;
    };
    return mod.getCurrentWindow?.() ?? null;
  } catch {
    // Desktop shell without the JS API bundled — treat as "no window control".
    return null;
  }
}

export interface EnterFullscreenResult {
  /** Is the OS window fullscreen now? False ⇒ the caller should fall back. */
  active: boolean;
  /** Did WE put it there? Only then may the caller take it back out. */
  owned: boolean;
}

const INACTIVE: EnterFullscreenResult = { active: false, owned: false };

/**
 * Put the desktop window on the whole display.
 *
 * Resolves `{ active:false }` — never rejects — when there is no window to
 * drive (browser) or the call is refused (capability not baked into this
 * build). A refusal is a routine outcome here, not an error: the desktop
 * binary's ACL is compiled in, so a freshly-shipped frontend can legitimately
 * run against a shell that predates the permission.
 */
export async function enterDesktopWindowFullscreen(): Promise<EnterFullscreenResult> {
  const win = await currentWindow();
  if (!win) return INACTIVE;
  try {
    // Already fullscreen (the user's own F11, or a previous caller): adopt it
    // WITHOUT claiming ownership, so we don't un-fullscreen their window later.
    if (await win.isFullscreen()) return { active: true, owned: false };
    await win.setFullscreen(true);
    // Trust the window, not the call: a denied capability can still resolve.
    const active = await win.isFullscreen();
    return { active, owned: active };
  } catch {
    return INACTIVE;
  }
}

/**
 * Take the desktop window back out of fullscreen.
 *
 * Call ONLY when `enterDesktopWindowFullscreen()` reported `owned: true` — see
 * the ownership note in this file's header.
 */
export async function exitDesktopWindowFullscreen(): Promise<void> {
  const win = await currentWindow();
  if (!win) return;
  try {
    await win.setFullscreen(false);
  } catch {
    /* Nothing to report: the window is either already out, or not ours to move. */
  }
}

/** Is the desktop window fullscreen right now? False in a browser. */
export async function isDesktopWindowFullscreen(): Promise<boolean> {
  const win = await currentWindow();
  if (!win) return false;
  try {
    return await win.isFullscreen();
  } catch {
    return false;
  }
}
