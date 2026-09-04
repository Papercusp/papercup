import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `routes/__root.tsx` imports `components/chat-faces/ChatFacesHost` EAGERLY (it
 * wraps `ChromeShell`), so every module ChatFacesHost imports STATICALLY lands
 * in the first-paint graph and gets modulepreloaded on every boot.
 *
 * `left-sidebar/left-sidebar.styles` is a ~110KB CSS-in-JS string that only the
 * chat-face PANES need, and every pane renders from a `render()` callback that
 * runs when the user opens the Fleet / Peers / Learning face. Importing it
 * statically here therefore shipped 110KB of first-paint JS to style a subtree
 * first paint never mounts (WI-5502, the P-009 client-bundle audit).
 *
 * This guard is source-level on purpose: it fails on the EDIT that would
 * reintroduce the eager edge, without needing a full `vite build` to observe it
 * in `dist/index.html`.
 */

const HERE = import.meta.dirname;
const CHAT_FACES_HOST = resolve(HERE, '../components/chat-faces/ChatFacesHost.tsx');
const LEFT_SIDEBAR = resolve(HERE, '../components/left-sidebar/LeftSidebar.tsx');
const STYLE_TAG = resolve(HERE, '../components/chat-faces/LeftSidebarStyleTag.tsx');

/** A top-level `import ... from '<spec>'` / `import '<spec>'` — NOT `import(...)`. */
function staticallyImports(source: string, specifierFragment: string): boolean {
  const quoted = String.raw`['"][^'"]*${specifierFragment}['"]`;
  // `(?<!\()` rejects the dynamic form: `import('...')` always has `(` before
  // the quote, a static import never does.
  const staticFrom = new RegExp(String.raw`^\s*import\s[^;]*?\sfrom\s+${quoted}`, 'm');
  const staticBare = new RegExp(String.raw`^\s*import\s+${quoted}`, 'm');
  return staticFrom.test(source) || staticBare.test(source);
}

function dynamicallyImports(source: string, specifierFragment: string): boolean {
  return new RegExp(String.raw`import\(\s*['"][^'"]*${specifierFragment}['"]\s*\)`).test(source);
}

describe('ChatFacesHost keeps the rail stylesheet out of the first-paint graph', () => {
  const host = readFileSync(CHAT_FACES_HOST, 'utf8');

  it('does not statically import the ~110KB rail stylesheet', () => {
    expect(staticallyImports(host, 'left-sidebar\\.styles')).toBe(false);
  });

  it('reaches the stylesheet only through a dynamic import boundary', () => {
    expect(dynamicallyImports(host, 'LeftSidebarStyleTag')).toBe(true);
    // The boundary is only real if the module behind it is what carries the CSS.
    expect(staticallyImports(readFileSync(STYLE_TAG, 'utf8'), 'left-sidebar\\.styles')).toBe(true);
  });

  it('calibration: the matcher detects the static import it is asserting the absence of', () => {
    // Positive control — LeftSidebar itself DOES import the stylesheet statically
    // (that edge is fine: LeftSidebar is already `lazy()` in __root). Without
    // this, a broken matcher would make the assertion above pass vacuously.
    expect(staticallyImports(readFileSync(LEFT_SIDEBAR, 'utf8'), 'left-sidebar\\.styles')).toBe(true);
    // And it must not mistake a dynamic import for a static one.
    expect(staticallyImports(`const X = lazy(() => import('./left-sidebar.styles'));`, 'left-sidebar\\.styles')).toBe(
      false,
    );
  });
});
