#!/usr/bin/env node
/**
 * Check if a package name is forbidden in the client.
 * @param {string} specifier - Specifier or package name
 * @returns {boolean}
 */
export function isForbidden(specifier: string): boolean;
/**
 * Try to resolve a module. Handles:
 *   - Relative paths (./foo, ../foo)
 *   - Path aliases (@/, ~/)
 *   - Bare exports (node_modules packages)
 * @param {string} spec - Specifier to resolve
 * @param {string} fromFile - Resolving file's absolute path
 * @returns {string | null} Resolved path, or null if not found
 */
export function resolveModulePath(spec: string, fromFile: string): string | null;
/**
 * Find a file by trying extensions: .ts, .tsx, .js, /index.ts, /index.tsx, /index.js
 * @param {string} base - Base path without extension
 * @returns {string | null} Resolved path or null
 */
export function findFile(base: string): string | null;
/**
 * Extract import/export specifiers from TypeScript AST.
 * @param {ts.SourceFile} source - Source file
 * @returns {string[]} Array of module specifiers
 */
export function extractImports(source: ts.SourceFile): string[];
/**
 * Walk the import graph from an entry file, tracking violations.
 * @param {string} entryFile - Absolute path to entry
 * @returns {{ files: Set<string>, violations: Map<string, string[][]> }}
 */
export function walkGraph(entryFile: string): {
    files: Set<string>;
    violations: Map<string, string[][]>;
};
/**
 * Format an import chain for display (entry → ... → forbidden).
 * @param {string[]} chain - Chain of files ending at the file importing the forbidden module
 * @param {string} forbidden - The forbidden module name
 * @returns {string}
 */
export function formatChain(chain: string[], forbidden: string, line: any): string;
/**
 * Main entrypoint
 */
export function main(): void;
import * as ts from 'typescript';
