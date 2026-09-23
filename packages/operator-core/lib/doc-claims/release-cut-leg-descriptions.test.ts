import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import releaseCutTool from '../agent-tools/release/cut';
import { ROOT } from './corpus-subject';

type DescribedField = { description?: string } | undefined;
type FieldShape = Record<string, DescribedField>;

const RELEASE_LOCAL = readFileSync(join(ROOT, 'papercusp-desktop/bin/release-local.sh'), 'utf8');

function legArgumentShapes(node: unknown, found: FieldShape[] = []): FieldShape[] {
  const schema = node as {
    shape?: FieldShape | (() => FieldShape);
    _def?: { shape?: FieldShape | (() => FieldShape); options?: unknown[] };
  };
  const direct = schema?.shape ?? schema?._def?.shape;
  const shape = typeof direct === 'function' ? direct() : direct;
  if (shape && 'mac' in shape && 'windows' in shape) found.push(shape);
  for (const option of schema?._def?.options ?? []) legArgumentShapes(option, found);
  return found;
}

function describesProducer(description: string, producer: string): boolean {
  return (
    description.includes(producer) &&
    /cross-compiled on Linux/i.test(description) &&
    /no VM or SSH/i.test(description) &&
    !/build VM|SSH\s*:222[23]/i.test(description)
  );
}

describe('release:cut leg descriptions track their actual producers', () => {
  const shapes = legArgumentShapes(releaseCutTool.args);

  it('resolves both preflight and run schemas instead of silently inspecting no descriptions', () => {
    expect(shapes).toHaveLength(2);
  });

  it('names the Linux macOS producer in both operations', () => {
    const descriptions = shapes.map((shape) => shape.mac?.description ?? '');
    expect(new Set(descriptions).size).toBe(1);
    expect(descriptions.every((description) => describesProducer(description, 'bin/build-mac-cross.sh'))).toBe(true);
  });

  it('names the Linux Windows producer in both operations', () => {
    const descriptions = shapes.map((shape) => shape.windows?.description ?? '');
    expect(new Set(descriptions).size).toBe(1);
    expect(descriptions.every((description) => describesProducer(description, 'bin/build-windows-cross.sh'))).toBe(true);
  });

  it('pins the named producers to the entrypoints release-local.sh actually invokes', () => {
    expect(RELEASE_LOCAL).toContain('MAC_PRODUCER="$ROOT/bin/build-mac-cross.sh"');
    expect(RELEASE_LOCAL).toContain('bash "$MAC_PRODUCER"');
    expect(RELEASE_LOCAL).toContain('WIN_PRODUCER="$ORCHESTRATOR_HERE/build-windows-cross.sh"');
    expect(RELEASE_LOCAL).toContain('"$WIN_TARGET_ENTRYPOINT" "$WIN_PRODUCER"');
  });

  it('CONTROL: rejects the retired VM-and-SSH descriptions', () => {
    expect(describesProducer('Include the macOS leg (build VM on SSH :2222).', 'bin/build-mac-cross.sh')).toBe(false);
    expect(describesProducer('Include the Windows leg (build VM on SSH :2223).', 'bin/build-windows-cross.sh')).toBe(false);
  });
});
