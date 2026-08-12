#!/usr/bin/env node
/**
 * THE gated-set selection — the single source of truth for "what does this leg compile?".
 *
 * ⚠ EXTRACTED SO IT HAS EXACTLY ONE IMPLEMENTATION (EI-19462776655300160). Both `main()` (which
 * RUNS the set) and `GATE_COVERAGE` (which DECLARES it to the sibling-gate resolver) read it from
 * here, so the resolver's view of this leg and what the leg actually does are the same fact rather
 * than two facts that agree until someone edits one. Drift would fail in the DANGEROUS direction:
 * over-claimed coverage routes an agent to a gate that silently skips their file.
 *
 * Pure: it decides, it never prints. `present: false` is the legitimate submodule-absent opt-out
 * (a subject hive, an uninitialised checkout) and is DISTINCT from "present but gating nothing",
 * which `main()` treats very differently — see its `packages.length === 0` branch.
 *
 * @param {{libsRoot?: string, relativeTo?: string}} [opts]
 * @returns {{present: boolean, packages: any[], unreadable: any[]}}
 */
export function selectGatedPackages({ libsRoot, relativeTo }?: {
    libsRoot?: string;
    relativeTo?: string;
}): {
    present: boolean;
    packages: any[];
    unreadable: any[];
};
export function main({ libsRoot, relativeTo, listOnly, spawn, log, warn, error, }?: {
    libsRoot?: string | undefined;
    relativeTo?: string | undefined;
    listOnly?: boolean | undefined;
    spawn?: typeof realSpawn | undefined;
    log?: {
        (...data: any[]): void;
        (message?: any, ...optionalParams: any[]): void;
    } | undefined;
    warn?: {
        (...data: any[]): void;
        (message?: any, ...optionalParams: any[]): void;
    } | undefined;
    error?: {
        (...data: any[]): void;
        (message?: any, ...optionalParams: any[]): void;
    } | undefined;
}): 0 | 1;
export function GATE_COVERAGE(): string[];
import { realSpawn } from './lib/typecheck-fanout.mjs';
import { discover } from './lib/typecheck-fanout.mjs';
import { looksOom } from './lib/typecheck-fanout.mjs';
import { runOne } from './lib/typecheck-fanout.mjs';
export { discover, looksOom, runOne };
