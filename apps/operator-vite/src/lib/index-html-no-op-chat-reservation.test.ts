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
 * The sidebar was retired 2026-07-09 and REVIVED 2026-07-13
 * (operator-chat-sidebar-revival-2026-07-13): OperatorChatSidebar writes
 * `has-op-chat` + `--op-chat-w` again — but only AT MOUNT, removing them on
 * unmount, exactly the D-017 contract. Flags are still unknowable pre-paint
 * (the sidebar is gated by FLAGS.OPERATOR_CHAT_SIDEBAR), so the pre-paint
 * reservation stays banned: this guard fails if anyone re-adds an
 * unconditional index.html bootstrap. The layout rails legitimately offset
 * by --op-chat-w again (mount-time writer exists), so the retired-era
 * "no rail mentions it" assertion is gone with the revival.
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
