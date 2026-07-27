#!/usr/bin/env node
/** Count "externalized for browser compatibility" warnings in a vite build's combined output. */
export function countExternalizedWarnings(buildOutput: any): number;
/**
 * Pure gate decision (mirrors lint-tsc.mjs decide() — EI-104's --update-only ratchet
 * policy, unit-testable in isolation).
 * @returns {{ verdict: 'fail-exceeds'|'ok-ratchet'|'ok-below'|'ok', newBaseline?: number, belowBy?: number }}
 */
export function decide({ warningCount, baselineCount, updateFlag }: {
    warningCount: any;
    baselineCount: any;
    updateFlag?: boolean | undefined;
}): {
    verdict: "fail-exceeds" | "ok-ratchet" | "ok-below" | "ok";
    newBaseline?: number;
    belowBy?: number;
};
