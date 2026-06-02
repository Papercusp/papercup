/**
 * `papercusp://workspace/harnesses` — workspace-scoped harness inventory.
 *
 * Concrete (non-templated) resource. Same data as the `harness:list`
 * tool; exposed as a resource so agents can browse and cache without
 * a tool call.
 */
declare const _default: import("@papercusp/tooldef").ResourceDefinition;
export default _default;
