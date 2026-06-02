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
declare const _default: import("@papercusp/tooldef").ToolDefinition<z.ZodObject<{
    greeting: z.ZodDefault<z.ZodString>;
}, z.core.$strip>>;
export default _default;
