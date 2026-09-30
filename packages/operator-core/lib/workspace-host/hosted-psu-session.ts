/**
 * D-002 (plan psu-cloud-connector-liveness-multi-signin-2026-09-29, P-006): a hosted terminal
 * whose ONLY process is psu.
 *
 * `psu --connect` to a Papercusp-hosted workspace used to land in the customer's own shell and
 * type `psu`, which cannot work there: the customer account cannot read the Papercusp runtime
 * (D-043), so it has no psu (WI-10003949, measured on avi-test). Under D-002 the host service
 * starts psu itself, and psu runs its agent CLI as the customer workspace account through the
 * D-424 identity wrapper — the same path a New Session launch already takes on this host.
 *
 * psu therefore runs as the SERVICE user, which is why this file is a security boundary:
 *
 * 1. The customer controls argv only, never env, and argv is ALLOWLISTED. psu has flags that read
 *    a service-owned path into the agent's context (`--launch-context`), write the service's own
 *    login (`--set-claude-token`), run signed commands with the service bearer (`--recovery-*`),
 *    or register under a caller-chosen identity (`--owner-id`, `--fleet`, `--workspace`, …). A
 *    denylist would silently admit the next such flag; an allowlist refuses it until someone
 *    decides it is safe (review: WI-10003949 comments 1151388/1151389/1151391).
 * 2. The command is psu itself, never a shell: when psu exits, the PTY exits and the session
 *    ends. There is no service-user shell to fall back to, by construction.
 * 3. `PAPERCUSP_PSU_HOSTED_CUSTOMER=1` puts psu in hosted-customer mode (P-008), where its own
 *    launcher refuses the same flags and never prompts for identity, fleet or a backend install.
 *
 * Resume and fork are allowed with a plain session id. A hosted machine serves exactly one
 * customer workspace, so every session its operator knows is that customer's, and the agent a
 * resume starts runs as the customer account like any other launch.
 */
import { posix } from 'node:path';
import { WORKSPACE_HOST_RELEASE_BIN_DIR } from '@papercusp/deployment-driver';
import { hostedAgentIdentityPsuEnv } from './hosted-agent-identity-psu-env';
import { localOperatorOrigin } from './hosted-operator-http';
import type { PtyAccessScope } from '../pty-ticket';

/** The env switch psu's launcher reads for hosted-customer mode (P-008). */
export const HOSTED_PSU_CUSTOMER_ENV = 'PAPERCUSP_PSU_HOSTED_CUSTOMER';

/** The release's psu entrypoint. Readable by the service user only (D-043). */
export const HOSTED_PSU_ENTRYPOINT = posix.join(WORKSPACE_HOST_RELEASE_BIN_DIR, 'psu');

/** More forwarded arguments than any real invocation needs; a longer list is refused. */
export const HOSTED_PSU_MAX_ARGS = 16;

/** The agent CLIs the customer agent toolchain carries (`hostedCustomerAgentCommand`). */
const HOSTED_PSU_AGENTS = new Set(['claude', 'codex', 'omp']);

const MODEL_SPEC = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LABEL_MAX = 128;

/** Flags that take no value. */
const HOSTED_PSU_BARE_FLAGS = new Set(['--no-picker', '--resume', '--fork', '--fork-session']);

/** Flags that take a value, with the check that value must pass. */
const HOSTED_PSU_VALUE_FLAGS: ReadonlyMap<string, (value: string) => boolean> = new Map([
  ['--agent', (value) => HOSTED_PSU_AGENTS.has(value)],
  ['--model', (value) => MODEL_SPEC.test(value)],
  ['--label', (value) => value.length > 0 && value.length <= LABEL_MAX && !/[\p{Cc}]/u.test(value)],
  ['--resume', (value) => SESSION_ID.test(value)],
]);

export type HostedPsuArgvResult = { ok: true; argv: string[] } | { ok: false; reason: string };

/**
 * Check the customer's psu arguments against the D-002 allowlist.
 *
 * Returns the arguments NORMALISED to the `--flag=value` form, so the argv psu receives has no
 * space-separated value it could read as a separate flag. Refuses the whole list on the first
 * argument it does not admit — including `--`, which would forward the rest verbatim to the agent.
 */
export function parseHostedPsuCustomerArgv(argv: unknown): HostedPsuArgvResult {
  if (argv === undefined || argv === null) return { ok: true, argv: [] };
  if (!Array.isArray(argv)) return { ok: false, reason: 'argv_not_a_list' };
  if (argv.length > HOSTED_PSU_MAX_ARGS) return { ok: false, reason: 'argv_too_long' };
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg: unknown = argv[i];
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > 512 || arg.includes('\0')) {
      return { ok: false, reason: 'argv_malformed' };
    }
    if (HOSTED_PSU_BARE_FLAGS.has(arg)) {
      out.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
    const check = HOSTED_PSU_VALUE_FLAGS.get(flag);
    if (!check) return { ok: false, reason: `flag_not_allowed:${flag.slice(0, 64)}` };
    if (value === undefined) {
      // Space form (`--agent codex`). `--resume` alone is the bare flag handled above.
      const next: unknown = argv[i + 1];
      if (typeof next !== 'string') return { ok: false, reason: `flag_needs_value:${flag}` };
      value = next;
      i++;
    }
    if (!check(value)) return { ok: false, reason: `flag_value_refused:${flag}` };
    out.push(`${flag}=${value}`);
  }
  return { ok: true, argv: out };
}

export interface HostedPsuSpawnInput {
  scope: PtyAccessScope;
  hostedSessionId: string;
  workspaceRoot: string;
  cols: number;
  rows: number;
  /** Already checked by {@link parseHostedPsuCustomerArgv}. */
  argv: readonly string[];
}

/**
 * psu as the PTY's only process, run by the host service.
 *
 * The env is the operator's own, as launch-su's New Session path gives psu on this host, with
 * the pieces a hosted-customer launch needs set explicitly. None of it comes from the customer.
 * The agent does not inherit it: the D-424 wrapper forwards only its allowlisted names.
 */
export function hostedPsuPtySpawnSpec(input: HostedPsuSpawnInput, baseEnv: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== 'linux') throw new Error('hosted_workspace_pty_requires_linux');
  return {
    accessScope: input.scope,
    command: HOSTED_PSU_ENTRYPOINT,
    args: [...input.argv],
    cwd: input.workspaceRoot,
    inheritEnv: true,
    taskId: input.hostedSessionId,
    cols: input.cols,
    rows: input.rows,
    env: {
      // A launch envelope's per-session state must not leak in from the operator's own env.
      PAPERCUSP_SID: undefined,
      PAPERCUSP_KICKOFF_PROMPT: undefined,
      PAPERCUSP_PSU_HEADLESS: undefined,
      PAPERCUSP_OPERATOR_URL_PROVENANCE: undefined,
      PAPERCUSP_OPERATOR_URL: localOperatorOrigin(baseEnv),
      PAPERCUSP_ACCOUNT_ROUTING_MODE: 'default',
      LANG: baseEnv.LANG || 'C.UTF-8',
      TERM: 'xterm-256color',
      ...hostedAgentIdentityPsuEnv(),
      [HOSTED_PSU_CUSTOMER_ENV]: '1',
    } as Record<string, string | undefined>,
  };
}
