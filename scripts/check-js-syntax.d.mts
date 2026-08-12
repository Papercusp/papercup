#!/usr/bin/env node
/**
 * The pure detector: resolves to `null` when the file parses, else a
 * `{ line, reason }` describing node's own parse error.
 *
 * Reads the exit CODE, never the output text. `node --check f 2>&1 | head -3`
 * reports HEAD's status (0) and reads exactly like a pass — the mistake made
 * while first measuring this class.
 */
export function findJsSyntaxError(absPath: any): Promise<any>;
export function isJsSyntaxScanned(f: any): any;
