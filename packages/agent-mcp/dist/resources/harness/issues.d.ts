/**
 * `papercusp://harness/{slug}/issues` — per-harness issue list.
 *
 * Templated resource. The `list` callback expands the template against
 * the workspace's harness inventory, so `resources/list` returns one
 * entry per active harness. This is the cross-harness consolidation
 * that the `issues:list` tool degraded out of.
 */
declare const _default: import("@papercusp/tooldef").ResourceDefinition;
export default _default;
