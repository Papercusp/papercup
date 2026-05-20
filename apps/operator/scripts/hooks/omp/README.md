# scripts/hooks/omp

OMP hook modules served to **workspace-power-user** OMP sessions in the
`hooks[]` array of `GET /api/agent-bundle` (see
`apps/operator/docs/plans/omp-power-user-bundle-2026-05-20.md` §4.3.1).

## Contract

Every `*.ts` / `*.js` / `*.mjs` file in this directory (this `README.md`
excluded) is read at request time by the agent-bundle route and shipped
inline. The `@papercusp/omp` plugin writes each into the session-scratch
dir and registers it with OMP via `--hook=<path>` — no global install.

This is the **single source of truth** for the OMP coordination hook.
The same files back two delivery paths (D-008a):

- **Power-user path** — served inline by `/api/agent-bundle`, written to
  session-scratch, passed via `--hook`.
- **Engineer path** — the install script copies the same files into
  `~/.omp/agent/hooks/`.

One source, two deliveries. Do not fork the hook between paths.

## v1 status

Empty by design. The coordination hook itself is owned by the
file-locking plan (`file-locking-improvements-2026-05-20.md`): one
module exporting `tool_call` (L2 file-lock enforcement),
`session_start` (L1 presence), and `turn_start` (L3 context
injection). Until it lands here, `/api/agent-bundle` returns
`hooks: []` and power-user sessions run without the coordination hook.
