/**
 * `dev:hello-card` — Phase E fixture tool.
 *
 * Validates the mcp-ui pipeline end-to-end without committing to a
 * real use case. Returns a tiny HTML card alongside its JSON data;
 * mcp-ui-aware clients render the card, text-only clients see the
 * data string. Replace this with a real tool when the use case lands;
 * delete it after that.
 *
 * Capability: `tasks:read` (low tier — fine for a dev fixture).
 */

import { z } from 'zod';
import { defineUITool } from '../../define-ui-tool';

export default defineUITool({
  name: 'dev:hello-card',
  profile: 'engineer',
  description:
    'Phase E fixture: returns a minimal mcp-ui card so external clients can verify UI rendering. Args: { greeting? }.',
  capability: 'tasks:read',
  args: z.object({
    greeting: z.string().default('hello from Papercusp'),
  }),
  async handler(args, _ctx): Promise<{
    data: { ok: true; greeting: string };
    html: string;
    uri: `ui://${string}`;
  }> {
    const html = `<!doctype html><html><body style="
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: #19232A; color: #e6edf3;
      margin: 0; padding: 18px 22px;
      border-radius: 8px;
    "><h2 style="margin:0 0 6px;font-size:14px;letter-spacing:.02em;
      text-transform:uppercase;opacity:.7;">papercusp · dev:hello-card</h2>
    <p style="margin:0;font-size:18px;">${args.greeting.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</p>
    </body></html>`;
    return {
      data: { ok: true, greeting: args.greeting },
      html,
      uri: `ui://dev/hello-card/${Date.now().toString(36)}`,
    };
  },
});
