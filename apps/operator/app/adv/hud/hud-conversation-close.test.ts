import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HUD_VIEW = readFileSync(new URL('./HudView.tsx', import.meta.url), 'utf8');

describe('HUD conversation close URL contract', () => {
  it('clears both conversation keys when Escape closes the popup', () => {
    expect(HUD_VIEW).toContain("useQueryState('agentConversation', parseAsString)");
    const modalStart = HUD_VIEW.indexOf('<SessionChatModal');
    const modalEnd = HUD_VIEW.indexOf('      />', modalStart);
    expect(modalStart).toBeGreaterThan(-1);
    expect(modalEnd).toBeGreaterThan(modalStart);
    const modal = HUD_VIEW.slice(modalStart, modalEnd);
    const closeStart = modal.indexOf('onClose={() => {');
    expect(closeStart).toBeGreaterThan(-1);
    const close = modal.slice(closeStart);
    expect(close).toContain('void setOpenOwner(null);');
    expect(close).toContain('void setConversation(null);');
  });
});
