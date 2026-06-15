// PackagedBuildTab — the WebdriverIO packaged-build runner tab. The render is a
// fetch-on-mount shell that maps the WDIO commands to CommandCards; the genuine
// logic is the install→build→test ordering (orderWdioCommands), extracted +
// exported and tested here. The surrounding tab is render-only.

import { describe, expect, it } from 'vitest';
import { orderWdioCommands } from './PackagedBuildTab';
import type { CommandSpec } from '../../_components/CommandCard';

function cmd(id: string): CommandSpec {
  return { id, label: id, section: 'building', command: `run ${id}` };
}

describe('orderWdioCommands', () => {
  it('returns the WDIO commands in the fixed install→build→test order', () => {
    // Provide them shuffled; the helper must reorder.
    const all = [
      cmd('wdio-test'),
      cmd('build-linux-prod'),
      cmd('unrelated-cmd'),
      cmd('wdio-webkit-driver-check'),
      cmd('wdio-install'),
    ];
    expect(orderWdioCommands(all).map((c) => c.id)).toEqual([
      'wdio-webkit-driver-check',
      'wdio-install',
      'build-linux-prod',
      'wdio-test',
    ]);
  });

  it('drops WDIO ids that are absent from the command list', () => {
    const all = [cmd('wdio-install'), cmd('wdio-test')];
    expect(orderWdioCommands(all).map((c) => c.id)).toEqual(['wdio-install', 'wdio-test']);
  });

  it('ignores commands that are not part of the WDIO pipeline', () => {
    const all = [cmd('some-other'), cmd('wdio-install')];
    expect(orderWdioCommands(all).map((c) => c.id)).toEqual(['wdio-install']);
  });

  it('returns an empty list when none of the WDIO commands are present', () => {
    expect(orderWdioCommands([cmd('x'), cmd('y')])).toEqual([]);
  });
});
