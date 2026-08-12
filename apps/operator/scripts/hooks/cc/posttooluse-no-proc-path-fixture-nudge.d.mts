#!/usr/bin/env node
/** True for a file type the detector's tree scan would cover. */
export function isCandidateFile(filePath: any): boolean;
/**
 * Walk up from the edited file until a directory carries the detector. Returns the
 * repo root, or null when the edit is outside any tree that has it (in which case the
 * hook stays silent rather than guessing).
 */
export function findRepoRoot(filePath: any, exists?: typeof existsSync): string | null;
/** The advisory text. Exported so the test asserts the real string. */
export function formatNudge(relPath: any, offenders: any): string;
/**
 * The whole check for one edited file. Returns the advisory string, or null.
 * Every dependency is injectable so the test can drive it without a real repo.
 */
export function nudgeFor(filePath: any, deps?: {}): Promise<string | null>;
import { existsSync } from 'node:fs';
