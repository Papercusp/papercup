import type { spawnSync } from 'node:child_process';

export declare const RESTRICTED_HOLD_PREFLIGHT_MARKER: 'RESTRICTED_HOLD_PREFLIGHT';
export declare const RESTRICTED_HOLD_PREFLIGHT_EXIT: Readonly<{ admit: 0; misuse: 2; refuse: 3 }>;
export declare const RESTRICTED_HOLD_PREFLIGHT_ENV: 'PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT';
export declare const RESTRICTED_HOLD_PREFLIGHT_DONE: 'admitted-by-testing-run';
export declare const RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER: 'admitted-by-test-router';
export declare const RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST: 'admitted-by-vitest-root';
export declare const RESTRICTED_HOLD_PREFLIGHT_CLI: string;

export type RestrictedHoldPreflightRefusal = { verdict: 'refuse'; error: string; hint: string };
export type RestrictedHoldPreflightSkipReason = 'testing-run' | 'admitted-upstream' | 'nested-in-vitest';
export type RestrictedHoldPreflightResult =
  | { verdict: 'admit' }
  | { verdict: 'skipped'; reason: RestrictedHoldPreflightSkipReason }
  | RestrictedHoldPreflightRefusal;

export type VitestRootPreflightSkipReason = 'testing-run' | 'admitted-upstream' | 'github-actions';
export type VitestRootPreflightResult =
  | { verdict: 'admit'; setEnv: Record<'PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT', 'admitted-by-vitest-root'> }
  | { verdict: 'skipped'; reason: VitestRootPreflightSkipReason }
  | RestrictedHoldPreflightRefusal;

export declare function restrictedHoldPreflightSkipReason(env: NodeJS.ProcessEnv): RestrictedHoldPreflightSkipReason | null;
export declare function vitestRootPreflightSkipReason(env: NodeJS.ProcessEnv): VitestRootPreflightSkipReason | null;

export declare function runVitestRootPreflight(opts: {
  repoRoot: string;
  files: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawn?: typeof spawnSync;
}): VitestRootPreflightResult;

export declare function formatVitestRestrictedHoldRefusal(refusal: { error: string; hint: string }): string;

export declare function interpretRestrictedHoldPreflight(result: {
  status: number | null;
  signal?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error;
}): { verdict: 'admit' } | RestrictedHoldPreflightRefusal;

export declare function runRestrictedHoldPreflight(opts: {
  repoRoot: string;
  files: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  spawn?: typeof spawnSync;
}): RestrictedHoldPreflightResult;

export declare function formatRestrictedHoldRefusal(refusal: { error: string; hint: string }): string;
