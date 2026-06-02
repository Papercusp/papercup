/**
 * `papercusp://workspace/audit/recent` — last 100 audit log entries.
 *
 * High-tier capability gate (audit:read) — same trust boundary as the
 * `audit:list` tool. Read-only snapshot of `harness_shared.audit_log`.
 */
declare const _default: import("@papercusp/tooldef").ResourceDefinition;
export default _default;
