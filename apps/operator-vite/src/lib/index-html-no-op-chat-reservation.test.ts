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
 * Flags are unknowable pre-paint, so the reservation must come ONLY from the
 * sidebar component itself at mount (OperatorChatSidebar sets the class/var
 * and carries the padding rules in OP_CHAT_SIDEBAR_CSS, removing them on
 * unmount). This guard fails if anyone re-adds a pre-paint reservation.
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
});
