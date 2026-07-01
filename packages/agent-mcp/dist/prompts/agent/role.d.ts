/**
 * `agent:role` — return the canonical role-prompt md for any agent role
 * (architect, orchestrator, scoper, worker, validator, debugger, …).
 *
 * Source of truth: libs/papercusp/packages/harness/blueprints/base/prompts/<role>.md.
 * Returns the file content as a single system-role message. Used by
 * external clients that want to spin up an LLM session with the same
 * persona Papercusp uses internally.
 */
declare const _default: import("@papercusp/tooldef").PromptDefinition;
export default _default;
