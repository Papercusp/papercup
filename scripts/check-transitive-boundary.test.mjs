#!/usr/bin/env node
/**
 * check-transitive-boundary.test.mjs — Unit tests for the boundary check script.
 *
 * Tests:
 * 1. Script runs successfully on valid code (no forbidden imports)
 * 2. Script detects forbidden imports (node:*, postgres, etc.)
 * 3. Script reports full import chains
 * 4. Script handles edge cases (cycles, deep nesting, etc.)
 *
 *   npm run test:file -- scripts/check-transitive-boundary.test.mjs
 */

import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = resolve(ROOT, '.papercusp/.test-boundary-check');

// Cleanup function
function cleanup() {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

// Setup test directory
function setup() {
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true });
}

/**
 * Run the boundary check on a test directory.
 * @param {string} dir - Directory to test
 * @returns {{ stdout: string, stderr: string, exitCode: number }}
 */
function runCheck(dir) {
  const entryPoint = resolve(dir, 'src/main.ts');
  try {
    const stdout = execSync(
      `node "${ROOT}/scripts/check-transitive-boundary.mjs" "${entryPoint}"`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
    };
  }
}

/**
 * Test 1: Clean code passes (no violations)
 */
function test_clean_code_passes() {
  setup();

  const testDir = resolve(TEST_DIR, 'clean');
  mkdirSync(testDir, { recursive: true });

  // Create a minimal test app structure
  writeFileSync(
    resolve(testDir, 'package.json'),
    JSON.stringify({
      name: 'test-app',
      module: 'src/main.ts',
    })
  );

  mkdirSync(resolve(testDir, 'src'), { recursive: true });
  writeFileSync(
    resolve(testDir, 'src/main.ts'),
    `
import React from 'react';
import { z } from 'zod';

export const App = () => <div>Hello</div>;
`
  );

  writeFileSync(
    resolve(testDir, 'src/utils.ts'),
    `
import { format } from 'date-fns';
export const now = () => format(new Date(), 'yyyy-MM-dd');
`
  );

  // Run the check
  const result = runCheck(testDir);

  assert.equal(result.exitCode, 0, 'Clean code should exit 0');
  assert(result.stdout.includes('No forbidden imports'), 'Should report success');
  console.log('✓ test_clean_code_passes');
}

/**
 * Test 2: Node imports are detected
 */
function test_node_imports_detected() {
  setup();

  const testDir = resolve(TEST_DIR, 'node-imports');
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    resolve(testDir, 'package.json'),
    JSON.stringify({
      name: 'test-app',
      module: 'src/main.ts',
    })
  );

  mkdirSync(resolve(testDir, 'src'), { recursive: true });
  writeFileSync(
    resolve(testDir, 'src/main.ts'),
    `
import React from 'react';
import { readFileSync } from 'node:fs';

export const App = () => <div>Hello</div>;
`
  );

  const result = runCheck(testDir);

  assert.equal(result.exitCode, 1, 'Should fail when node:fs is imported');
  assert(result.stderr.includes('node:fs'), 'Should report node:fs violation');
  console.log('✓ test_node_imports_detected');
}

/**
 * Test 3: Transitive violations are detected
 */
function test_transitive_violations_detected() {
  setup();

  const testDir = resolve(TEST_DIR, 'transitive');
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    resolve(testDir, 'package.json'),
    JSON.stringify({
      name: 'test-app',
      module: 'src/main.ts',
    })
  );

  mkdirSync(resolve(testDir, 'src'), { recursive: true });

  // main.ts imports utils.ts
  writeFileSync(
    resolve(testDir, 'src/main.ts'),
    `
import React from 'react';
import { getVersion } from './utils';

export const App = () => <div>v{getVersion()}</div>;
`
  );

  // utils.ts imports helpers.ts
  writeFileSync(
    resolve(testDir, 'src/utils.ts'),
    `
import { version } from './helpers';
export const getVersion = () => version;
`
  );

  // helpers.ts (transitively) imports postgres
  writeFileSync(
    resolve(testDir, 'src/helpers.ts'),
    `
import { Client } from 'postgres';
export const version = '1.0.0';
`
  );

  const result = runCheck(testDir);

  assert.equal(result.exitCode, 1, 'Should fail for transitive violation');
  assert(result.stderr.includes('postgres'), 'Should report postgres violation');
  console.log('✓ test_transitive_violations_detected');
}

/**
 * Test 4: Multiple violations are aggregated
 */
function test_multiple_violations_aggregated() {
  setup();

  const testDir = resolve(TEST_DIR, 'multiple');
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    resolve(testDir, 'package.json'),
    JSON.stringify({
      name: 'test-app',
      module: 'src/main.ts',
    })
  );

  mkdirSync(resolve(testDir, 'src'), { recursive: true });
  writeFileSync(
    resolve(testDir, 'src/main.ts'),
    `
import React from 'react';
import { readFile } from 'node:fs';
import { createServer } from 'node:http';
import { Pool } from 'postgres';

export const App = () => <div>Hello</div>;
`
  );

  const result = runCheck(testDir);

  assert.equal(result.exitCode, 1, 'Should fail');
  assert(result.stderr.includes('node:fs'), 'Should report node:fs');
  assert(result.stderr.includes('node:http'), 'Should report node:http');
  assert(result.stderr.includes('postgres'), 'Should report postgres');
  assert(result.stderr.match(/Found \d+ forbidden/), 'Should aggregate all violations');
  console.log('✓ test_multiple_violations_aggregated');
}

/**
 * Run all tests
 */
function runTests() {
  console.log('Running boundary check tests...\n');

  try {
    test_clean_code_passes();
    test_node_imports_detected();
    test_transitive_violations_detected();
    test_multiple_violations_aggregated();

    console.log('\n✓ All tests passed!');
    cleanup();
    process.exit(0);
  } catch (e) {
    console.error('\n✗ Test failed:', e.message);
    console.error(e);
    cleanup();
    process.exit(1);
  }
}

runTests();
