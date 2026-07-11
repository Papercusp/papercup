/**
 * defineUITool — convenience helper for tools that return UI fragments.
 *
 * Wraps defineTool. The handler returns `{ data, html?, externalUrl? }`
 * and this helper:
 *   - Calls @mcp-ui/server's `createUIResource` to build a spec-shaped
 *     UIResource payload.
 *   - Adds it to the ToolResponse's uiResources[] alongside `data`.
 *
 * Tools that need richer control (multiple resources, base64 blobs,
 * adapter configs) can drop down to defineTool and construct the
 * UIResource manually.
 *
 * Example:
 *   defineUITool({
 *     name: 'dispatch:card',
 *     capability: 'tasks:read',
 *     args: z.object({ slug: z.string() }),
 *     async handler({ slug }, ctx) {
 *       return {
 *         data: { ok: true },
 *         html: `<div>Dispatching to ${slug}…</div>`,
 *         uri: `ui://dispatch-card/${slug}`,
 *       };
 *     },
 *   });
 */
import { createUIResource } from '@mcp-ui/server';
import { defineTool } from '@papercusp/tooldef';
function rand() {
    return Math.random().toString(36).slice(2, 10);
}
export function defineUITool(input) {
    return defineTool({
        ...input,
        handler: async (args, ctx) => {
            const r = await input.handler(args, ctx);
            const uiResources = [];
            if (r.html || r.externalUrl) {
                const uri = (r.uri ?? `ui://${input.name ?? 'tool'}/${rand()}`);
                const ui = createUIResource({
                    uri,
                    content: r.html
                        ? { type: 'rawHtml', htmlString: r.html }
                        : { type: 'externalUrl', iframeUrl: r.externalUrl },
                    encoding: 'text',
                    metadata: r.metadata,
                });
                uiResources.push(ui);
            }
            const response = { data: r.data };
            if (uiResources.length)
                response.uiResources = uiResources;
            if (r.nextCursor)
                response.nextCursor = r.nextCursor;
            return response;
        },
    });
}
