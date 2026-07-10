/**
 * D-017 regression guard (native-terminal-desktop-2026-06-06): index.html
 * must NOT unconditionally reserve the operator-chat sidebar column.
 *
 * The defect class: a pre-React body-start bootstrap added
 * `body.has-op-chat` + `--op-chat-w` on every load — from when the web chat
 * was the default UX. After P-016 put the chat behind FLAGS.TESTING the
 * sidebar never mounts by default, so nothing removed the class and the app
 * showed a permanent blank left column (on the owner's instance 760px, the
 * bootstrap having restored a drag-resized width from localStorage).
 *
 * The sidebar is now RETIRED outright (design-simplification-2026-07-09 P-010;
 * see _retired/legacy-web-chats/) — the desktop chat is the terminal-native pui
 * dock. So NOTHING writes `--op-chat-w` any more, and the layout rails that
 * used to offset by it (they read it with a `0px` fallback, i.e. always 0)
 * no longer mention it. This guard fails if either the pre-paint reservation
 * or a rail's phantom offset comes back.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexHtml = readFileSync(join(__dirname, '../../index.html'), 'utf8');

describe('index.html op-chat reservation (D-017)', () => {
  it('has no pre-paint has-op-chat bootstrap', () => {
    // The old bootstrap's signature lines — any of them coming back means the
    // unconditional reservation has been reintroduced.
    expect(indexHtml).not.toContain("classList.add('has-op-chat')");
    expect(indexHtml).not.toContain('classList.add("has-op-chat")');
    expect(indexHtml).not.toContain('op-chat-width-reserve');
  });

  it('does not pre-set the --op-chat-w variable', () => {
    expect(indexHtml).not.toContain("setProperty('--op-chat-w'");
    expect(indexHtml).not.toContain('setProperty("--op-chat-w"');
  });

  // Nothing has written --op-chat-w since the sidebar was retired, so a rail
  // reading it was offsetting by a var that could only ever resolve to its 0px
  // fallback. Re-introducing the read would be dead layout math, not a feature.
  it('no layout rail offsets by the retired --op-chat-w', () => {
    const rails = [
      '../components/left-sidebar/left-sidebar.styles.ts',
      '../components/left-sidebar/LeftSidebar.tsx',
      '../components/dev-admin-rail/dev-admin-rail.styles.ts',
    ];
    for (const rail of rails) {
      expect(readFileSync(join(__dirname, rail), 'utf8')).not.toContain('--op-chat-w');
    }
  });
});
