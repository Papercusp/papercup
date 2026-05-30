/**
 * Re-export shim — the IPC frame codec now lives in @papercusp/ipc-framing
 * (extracted per papercusp-systems-abstraction-2026-05-29, P-030). Kept at
 * this path so the endpoint-ipc consumers (server.ts, sys-http.ts, tests)
 * resolve unchanged; new code should import from '@papercusp/ipc-framing'.
 *
 * NOTE: the Rust client in papercusp-desktop mirrors this codec byte-for-byte
 * (see endpoint-ipc/PROTOCOL.md) — the wire contract is unchanged by this move.
 */
export * from '@papercusp/ipc-framing';
