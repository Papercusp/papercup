/**
 * P-001 recurrence guard for the inference-gateway capacity census.
 *
 * The empty-list assertion is only useful when the detector can fail.  These tests
 * therefore exercise both sides: every listed writer must still be present at its
 * exact source anchor, and a synthetic new numeric concurrency writer must be
 * reported as unclassified without mutating the shared checkout.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPACITY_WRITER_SYMBOL_PATTERN,
  INFERENCE_GATEWAY_CAPACITY_INVENTORY,
  INFERENCE_GATEWAY_CAPACITY_INVENTORY_FILES,
  INFERENCE_GATEWAY_CAPACITY_INVENTORY_SCHEMA_VERSION,
  INFERENCE_GATEWAY_CAPACITY_SCOPE_PREFIXES,
  findInferenceGatewayCapacityDeclarations,
  scanInferenceGatewayCapacityInventory,
  validateInferenceGatewayCapacityInventory,
} from './capacity-inventory';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function collectFiles(path: string, out: string[] = []): string[] {
  const normalizedPath = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const full = join(ROOT, normalizedPath);
  if (!existsSync(full)) return out;
  const stat = statSync(full);
  if (!stat.isDirectory()) {
    out.push(normalizedPath);
    return out;
  }
  for (const entry of readdirSync(full)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '_retired') continue;
    const child = `${normalizedPath}/${entry}`;
    const childFull = join(ROOT, child);
    if (statSync(childFull).isDirectory()) collectFiles(child, out);
    else if (/\.(?:ts|tsx|mts|mjs|service|conf)$/.test(entry)) out.push(child.replaceAll('\\', '/'));
  }
  return out;
}

function liveSourceFiles(): Array<{ path: string; source: string }> {
  const paths = [...new Set(INFERENCE_GATEWAY_CAPACITY_SCOPE_PREFIXES.flatMap((prefix) => collectFiles(prefix)))];
  return paths
    .filter((path) => !/(?:^|\/)(?:dist|node_modules|_retired)\//.test(path))
    .filter((path) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path))
    .map((path) => ({ path, source: readFileSync(join(ROOT, path), 'utf8') }));
}

describe('inference-gateway capacity writer inventory (P-001)', () => {
  it('has a versioned, non-trivial manifest with complete evidence fields', () => {
    expect(INFERENCE_GATEWAY_CAPACITY_INVENTORY_SCHEMA_VERSION).toBe('inference-gateway-capacity-inventory-v1');
    expect(INFERENCE_GATEWAY_CAPACITY_INVENTORY.length).toBeGreaterThanOrEqual(30);
    expect(validateInferenceGatewayCapacityInventory()).toEqual([]);
    expect(new Set(INFERENCE_GATEWAY_CAPACITY_INVENTORY.map((row) => row.id)).size).toBe(
      INFERENCE_GATEWAY_CAPACITY_INVENTORY.length,
    );
    expect(new Set(INFERENCE_GATEWAY_CAPACITY_INVENTORY.map((row) => row.disposition))).toEqual(
      new Set(['remove', 'transient-feedback', 'semantic-protocol-safety', 'measured-external-physical-contract']),
    );
  });

  it('points every row at a real production file and exact writer anchor', () => {
    const files = new Map(liveSourceFiles().map((file) => [file.path, file.source]));
    for (const row of INFERENCE_GATEWAY_CAPACITY_INVENTORY) {
      expect(files.has(row.file), `${row.id} points at an unscanned file ${row.file}`).toBe(true);
      expect(files.get(row.file), `${row.id} source anchor disappeared`).toContain(row.sourceAnchor);
      expect(row.recurrenceTest).toContain('capacity-inventory.test.ts');
    }
    expect(INFERENCE_GATEWAY_CAPACITY_INVENTORY_FILES.length).toBe(
      new Set(INFERENCE_GATEWAY_CAPACITY_INVENTORY.map((row) => row.file)).size,
    );
  });

  it('keeps the live source census clean', () => {
    expect(scanInferenceGatewayCapacityInventory(liveSourceFiles())).toEqual([]);
  });

  it('detects a new named numeric capacity writer (the guard has teeth)', () => {
    const synthetic = [
      {
        path: 'packages/operator-core/lib/inference-gateway/synthetic.ts',
        source: 'export const NEW_GATEWAY_CONCURRENCY = 999;\n',
      },
    ];
    const findings = scanInferenceGatewayCapacityInventory(synthetic, {
      rows: [],
      scopePrefixes: ['packages/operator-core/lib/inference-gateway/'],
    });
    expect(findings).toContain('unclassified-writer:packages/operator-core/lib/inference-gateway/synthetic.ts:NEW_GATEWAY_CONCURRENCY:1');
  });

  it('detects source drift instead of silently dropping a row', () => {
    const row = INFERENCE_GATEWAY_CAPACITY_INVENTORY[0];
    const findings = scanInferenceGatewayCapacityInventory(
      [{ path: row.file, source: 'export const DEFAULT_CONCURRENCY = 25;' }],
      { rows: [row], declarations: false },
    );
    expect(findings).toContain(`writer-anchor-missing:${row.id}:${row.file}:${row.symbol}`);
  });

  it('does not mistake prose, strings, or unrelated bounds for capacity declarations', () => {
    const source = `
      // const FAKE_CONCURRENCY = 100;
      const text = "DEFAULT_MAX_QUEUED = 256";
      const DEFAULT_TIMEOUT_MS = 5000;
    `;
    expect(findInferenceGatewayCapacityDeclarations(source)).toEqual([]);
    expect(CAPACITY_WRITER_SYMBOL_PATTERN.test('DEFAULT_TIMEOUT_MS')).toBe(false);
  });

  it('keeps the inventory rooted in the repository (no generated/public copies)', () => {
    for (const row of INFERENCE_GATEWAY_CAPACITY_INVENTORY) {
      expect(row.file.startsWith('apps/operator/public/')).toBe(false);
      expect(row.file.includes('/dist/')).toBe(false);
      expect(relative(ROOT, resolve(ROOT, row.file))).toBe(row.file);
    }
  });
});
