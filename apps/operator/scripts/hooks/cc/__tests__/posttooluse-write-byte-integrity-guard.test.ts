/**
 * Regression coverage for EI-21220966892195714: a full Write can report success
 * while the resulting bytes differ from the printable content supplied to it.
 * The exact incident changed a quoted space (0x20) into NUL (0x00) twice.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const HOOK = resolve(__dirname, '../posttooluse-write-byte-integrity-guard.mjs');

async function hookMod() {
  return (await import(`file://${HOOK}`)) as typeof import('../posttooluse-write-byte-integrity-guard.mjs');
}

describe('posttooluse-write-byte-integrity-guard', () => {
  it('detects the incident shape: requested space became NUL on disk', async () => {
    const { inspectWrite, formatMismatch } = await hookMod();
    const hit = inspectWrite(
      { tool_name: 'Write', tool_input: { file_path: '/tmp/text-drift-report.ts', content: "const key = ' ';\n" } },
      () => Buffer.from("const key = '\x00';\n", 'utf8'),
    );

    expect(hit).toMatchObject({ expected: 0x20, actual: 0x00, offset: 13 });
    expect(formatMismatch(hit!)).toContain('expected 0x20, found 0x00');
    expect(formatMismatch(hit!)).toContain('EI-21220966892195714');
  });

  it('checks MCP capability:write and compares UTF-8 bytes, including non-ASCII text', async () => {
    const { inspectWrite } = await hookMod();
    const content = 'café — separator: " "\n';
    const hit = inspectWrite(
      {
        tool_name: 'mcp__papercusp-su__capability_write',
        tool_input: { file_path: 'packages/x.ts', content },
      },
      () => Buffer.from(content, 'utf8'),
    );
    expect(hit).toBeNull();
  });

  it('stays silent for partial writers and unrelated tools', async () => {
    const { inspectWrite } = await hookMod();
    const read = () => Buffer.from('different', 'utf8');
    for (const tool_name of ['Edit', 'MultiEdit', 'Bash', 'mcp__papercusp-su__capability_edit']) {
      expect(inspectWrite({ tool_name, tool_input: { file_path: '/tmp/x.ts', content: 'expected' } }, read)).toBeNull();
    }
  });

  it('fails open when the file cannot be read or content/path is unavailable', async () => {
    const { inspectWrite } = await hookMod();
    expect(
      inspectWrite(
        { tool_name: 'Write', tool_input: { file_path: '/tmp/x.ts', content: 'expected' } },
        () => {
          throw new Error('unreadable');
        },
      ),
    ).toBeNull();
    expect(inspectWrite({ tool_name: 'Write', tool_input: { file_path: '/tmp/x.ts' } }, () => Buffer.alloc(0))).toBeNull();
    expect(inspectWrite({ tool_name: 'Write', tool_input: { content: 'expected' } }, () => Buffer.alloc(0))).toBeNull();
  });

  it('emits a PostToolUse additionalContext diagnostic through the real stdin boundary', () => {
    const payload = {
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/ei-21220966892195714-missing-file.ts', content: 'x' },
    };
    // A missing result file verifies that malformed/unavailable comparisons remain
    // fail-open at the process boundary without depending on shared-tree content.
    const out = execFileSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });

  it('passes its embedded self-test', () => {
    const out = execFileSync('node', [HOOK, '--self-test'], { encoding: 'utf8' });
    expect(out).toMatch(/all cases passed/);
  });
});
