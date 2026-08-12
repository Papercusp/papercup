#!/usr/bin/env node
/**
 * Pure — builds the JSON payload printed on success. Exported (and unit
 * tested, no DB required) so the `.DRAFT`-suffix contract (EI-19366138707071397)
 * can't silently regress: `path` must be the DRAFT write-target, `arm_path`
 * the eventual armed `.sql` name, and `arm_command` the exact rename between
 * them — see the module-level docstring for why the suffix matters.
 *
 * @param {object} args
 * @param {number} args.next          The reserved migration number.
 * @param {string} args.filename      The eventual armed `<NNN>-<slug>.sql` filename.
 * @param {string} args.reservedBy    Who/what reserved it (for the printed `reserved_by`).
 * @param {boolean} args.dryRun       True when nothing was actually reserved.
 * @param {string} [args.canonicalDir] Override for the sql dir (tests only).
 */
export function buildAllocationResult({ next, filename, reservedBy, dryRun, canonicalDir }: {
    next: number;
    filename: string;
    reservedBy: string;
    dryRun: boolean;
    canonicalDir?: string | undefined;
}): {
    ok: boolean;
    number: number;
    reserved: boolean;
    filename: string;
    path: string;
    arm_path: string;
    arm_command: string;
    reserved_by: string;
    forward_compat: string;
    note: string;
};
