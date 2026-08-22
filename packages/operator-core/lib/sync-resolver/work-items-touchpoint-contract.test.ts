import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

const workItemsPanel = read('apps/operator/app/adv/harnesses/WorkItemsPanel.tsx');
const depGraphPanel = read('apps/operator/app/adv/harnesses/DepGraphPanel.tsx');
const detailPanel = read('apps/operator/app/adv/harnesses/DetailPanel.tsx');
const chatPanel = read('apps/operator/app/adv/harnesses/AdvChatPanel.tsx');
const hudView = read('apps/operator/app/adv/hud/HudView.tsx');
const harnessesDock = read('apps/operator/app/adv/harnesses/HarnessesDock.tsx');
const overviewTab = read('apps/operator-vite/src/components/adv/AdvOverviewTab.tsx');

describe('P-004 Work Items seven-touchpoint migration contract', () => {
  it('migrates grid and graph to the same server predicate + exact companion summary', () => {
    for (const [label, source] of [
      ['WorkItemsPanel', workItemsPanel],
      ['DepGraphPanel', depGraphPanel],
    ] as const) {
      expect(source, label).toContain("queryName: 'workItems.byHarness'");
      expect(source, label).toContain("queryName: 'workItems.summary'");
      expect(source, label).toContain('workItemServerFilters(');
      expect(source, label).toContain('sharedArgs');
    }
    expect(workItemsPanel).toContain('nextCursor');
    expect(workItemsPanel).toContain('setCursor(nextCursor)');
  });

  it('keeps selected-row authority on the one-row detail query, never page membership', () => {
    expect(detailPanel).toContain("queryName: 'workItems.detail'");
    expect(detailPanel).not.toContain("queryName: 'workItems.byHarness'");
  });

  it('preserves the intentionally bounded chat picker without claiming a corpus count', () => {
    expect(chatPanel).toContain("queryName: 'workItems.byHarness'");
    expect(chatPanel).toContain('states: PICKER_FETCH_STATES');
    expect(chatPanel).toContain('perState: PICKER_PER_STATE');
    expect(chatPanel).not.toContain("queryName: 'workItems.summary'");
  });

  it('preserves the HUD fair slice while sourcing displayed totals from exact aggregates', () => {
    expect(hudView).toContain("queryName: 'workItems.byHarness'");
    expect(hudView).toContain('states: HUD_WORK_ITEM_FETCH_STATES');
    expect(hudView).toContain('perState: WORK_ITEM_PER_STATE');
    expect(hudView).toContain("queryName: 'workItems.stats'");
    expect(hudView).toContain('totals: itemTotals');
  });

  it('keeps HarnessesDock as registry wiring only', () => {
    expect(harnessesDock).toContain("panelRegistry.register('adv:work-items', WorkItemsPanel");
    expect(harnessesDock).toContain("panelRegistry.register('adv:dep-graph', DepGraphPanel");
    expect(harnessesDock).not.toContain('useSyncQuery');
    expect(harnessesDock).not.toContain("queryName: 'workItems.");
  });

  it('keeps Overview on the aggregate stats path instead of loading list rows', () => {
    expect(overviewTab).toContain("queryName: 'workItems.stats'");
    expect(overviewTab).not.toContain("queryName: 'workItems.byHarness'");
    expect(overviewTab).not.toContain("queryName: 'workItems.summary'");
  });
});
