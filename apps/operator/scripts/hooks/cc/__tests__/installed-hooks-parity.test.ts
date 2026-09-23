import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLED_DIR = join(homedir(), '.papercusp', 'hooks', 'cc');
const INSTALLED_EXTENSIONS = new Set(['.mjs', '.py', '.sh']);

function hookFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      const ext = name.slice(name.lastIndexOf('.'));
      return (
        INSTALLED_EXTENSIONS.has(ext) &&
        !name.endsWith('.tmp') &&
        !name.endsWith('.bak') &&
        !name.includes('.bak-')
      );
    })
    .sort();
}

function parityProblems(sourceDir: string, installedDir: string): string[] {
  const sources = hookFiles(sourceDir);
  if (sources.length === 0) return ['source hook population is empty'];

  return sources.flatMap((name) => {
    const source = join(sourceDir, name);
    const installed = join(installedDir, name);
    if (!existsSync(installed)) return [`missing installed hook: ${name}`];
    return readFileSync(source).equals(readFileSync(installed))
      ? []
      : [`installed bytes differ: ${name}`];
  });
}

describe('installed cc hook parity', () => {
  it('detects a missing installed hook and byte drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-hook-parity-'));
    const sourceDir = join(root, 'source');
    const installedDir = join(root, 'installed');
    mkdirSync(sourceDir);
    mkdirSync(installedDir);

    try {
      writeFileSync(join(sourceDir, 'probe.sh'), 'source bytes\n');
      expect(parityProblems(sourceDir, installedDir)).toEqual([
        'missing installed hook: probe.sh',
      ]);

      writeFileSync(join(installedDir, 'probe.sh'), 'source bytes\n');
      expect(parityProblems(sourceDir, installedDir)).toEqual([]);

      writeFileSync(join(installedDir, 'probe.sh'), 'stale installed bytes\n');
      expect(parityProblems(sourceDir, installedDir)).toEqual([
        'installed bytes differ: probe.sh',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  if (existsSync(INSTALLED_DIR)) {
    it('every current hook source matches the installed runtime copy byte-for-byte', () => {
      expect(parityProblems(SOURCE_DIR, INSTALLED_DIR)).toEqual([]);
    });
  } else {
    it.skip('every current hook source matches the installed runtime copy byte-for-byte (no local install)');
  }
});
