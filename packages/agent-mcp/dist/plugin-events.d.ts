/**
 * JSON-Schema → wire-kind classifier + validator for plugin event
 * declarations. Phase 4 T3.2.
 *
 * Plugins declare typed events in their `papercusp.json` manifest as
 * JSON-Schema (they don't ship Zod, which would need an extra runtime
 * dependency). The framework needs three things from each plugin
 * event schema:
 *   1. A wire kind ('string' | 'binary' | 'json') so the SSE / IPC
 *      transports know how to serialize the event payload.
 *   2. The serialized JSON-Schema for tools/list discoverability —
 *      same surface built-in tools get via `z.toJSONSchema()`.
 *   3. A loud rejection at manifest-validate time if the plugin
 *      author uses a JSON-Schema keyword we don't support.
 *
 * The supported-keyword set is intentionally small. Plugins author
 * stable wire schemas; we don't try to support every JSON-Schema
 * draft feature. Plugin authors who hit the wall file a request.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T3.2.
 */
import type { EventWireKind } from '@papercusp/tooldef';
/** Reserved JSON-Schema keywords we explicitly support. */
export declare const SUPPORTED_KEYWORDS: Set<string>;
/**
 * Keywords we deliberately reject. The plugin author hits a clear
 * error rather than a silent "this didn't take effect."
 */
export declare const REJECTED_KEYWORDS: Set<string>;
export declare class PluginEventSchemaError extends Error {
    constructor(message: string);
}
/**
 * Classify a JSON-Schema-typed event into a wire kind. Mirrors
 * `classifyEventWire` (the Zod-based classifier in tool-projection.ts).
 * Same rules:
 *   - `{type: 'string', contentEncoding: 'base64'}` → 'binary'
 *   - `{type: 'string'}` → 'string'
 *   - everything else → 'json'
 *
 * Doesn't validate the schema — call `validatePluginEventSchema`
 * separately for that.
 */
export declare function classifyEventWireFromJsonSchema(schema: Record<string, unknown>): EventWireKind;
/**
 * Validate a single event's JSON-Schema against our supported subset.
 * Recurses into `properties` and `items`. Throws PluginEventSchemaError
 * on the first violation with a clear error message identifying the
 * offending keyword and the supported alternatives.
 *
 * `path` is a dotted breadcrumb (e.g. "delta.text") used in error
 * messages to point at nested violations.
 */
export declare function validatePluginEventSchema(eventName: string, schema: Record<string, unknown>, path?: string): void;
/**
 * Convenience: validate an entire `events: Record<name, JSON-Schema>`
 * map. Used by manifest-validate.ts before the plugin loader passes
 * events to registerProjectedTool. Returns a wire-kind map computed
 * in the same pass (saves a second tree walk).
 */
export declare function validateAndClassifyPluginEvents(events: Record<string, Record<string, unknown>>): Record<string, EventWireKind>;
