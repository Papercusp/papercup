/**
 * Static assertion: every chat-surface route includes expected MCP
 * tools, and interactive tools are excluded from one-shot surfaces.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-027.
 * Migrated from apps/operator/__tests__/integration/chat-surface-tools.mjs.
 * Pure-static — no operator process needed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../../../../');

const REQUIRED = [
  'mcp__agentmcp__agent_tools:list',
  'mcp__agentmcp__ui:list_clients',
  'mcp__agentmcp__ui:get_state',
  'mcp__agentmcp__ui:dispatch',
  'mcp__agentmcp__chat:ask_choice',
];
const INTERACTIVE_ONLY = ['mcp__agentmcp__chat:ask_choice'];

const SURFACES = [
  { label: 'operator-converse', kind: 'chat',       file: 'apps/operator/app/api/agent-mcp/operator-converse/route.ts', tool: 'apps/operator/lib/agent-tools/operator/converse.ts' },
  { label: 'delegate-chat',     kind: 'chat',       file: 'apps/operator/app/api/agent-mcp/delegate-chat/route.ts',     tool: 'apps/operator/lib/agent-tools/operator/delegate.ts' },
  { label: 'oracle',            kind: 'chat',       file: 'apps/operator/app/api/_hono/oracle.ts' },
  { label: 'operator-scan',     kind: 'oneshot',    file: 'apps/operator/app/api/agent-mcp/operator-scan/route.ts',     tool: 'apps/operator/lib/agent-tools/operator/scan.ts' },
  { label: 'spawn-pi',          kind: 'url-bridge', file: 'apps/operator/app/api/agent-mcp/spawn-pi/route.ts' },
] as const;

const SHARED = readFileSync(join(REPO, 'apps/operator/lib/operator-mcp-tools.ts'), 'utf8');

function effectiveSourceFor(src: string): string {
  return /from\s+'@\/lib\/operator-mcp-tools'/.test(src) ? src + '\n' + SHARED : src;
}

describe('chat-surface tool coverage (static)', () => {
  for (const surface of SURFACES) {
    describe(`${surface.label} (${surface.kind})`, () => {
      const routeSrc = readFileSync(join(REPO, surface.file), 'utf8');
      const toolSrc = 'tool' in surface && surface.tool ? readFileSync(join(REPO, surface.tool), 'utf8') : '';
      const src = toolSrc ? `${routeSrc}\n/* tool */\n${toolSrc}` : routeSrc;

      if (surface.kind === 'url-bridge') {
        it('points at /api/mcp?superuser=1', () => expect(src).toMatch(/\/api\/mcp\?superuser=1/));
        it('uses mcp-remote bridge', () => expect(src).toMatch(/mcp-remote/));
        return;
      }

      const effectiveSrc = effectiveSourceFor(src);

      if (surface.kind === 'chat') {
        for (const tool of REQUIRED) {
          it(`includes ${tool}`, () => expect(effectiveSrc).toContain(tool));
        }
      } else {
        // oneshot
        for (const tool of REQUIRED) {
          if (INTERACTIVE_ONLY.includes(tool)) {
            it(`does NOT include ${tool} as string literal`, () => {
              expect(new RegExp(`['"\`]${tool.replace(/:/g, '\\:')}['"\`]`).test(src)).toBe(false);
            });
          } else {
            it(`includes ${tool}`, () => expect(effectiveSrc).toContain(tool));
          }
        }
        it('uses NON_INTERACTIVE_AGENT_MCP_TOOLS (not ALL_AGENT_MCP_TOOLS)', () => {
          expect(/NON_INTERACTIVE_AGENT_MCP_TOOLS/.test(src) || !/ALL_AGENT_MCP_TOOLS/.test(src)).toBe(true);
        });
      }

      if (surface.label === 'oracle') {
        it('no legacy mcp__oracle__ string literals', () => {
          expect(/['"]mcp__oracle__[a-zA-Z]+['"]/.test(src)).toBe(false);
        });
        it('wires agent_chats:create + send_message', () => {
          expect(src).toContain('mcp__agentmcp__agent_chats:create');
          expect(src).toContain('mcp__agentmcp__agent_chats:send_message');
        });
      }
    });
  }

  describe('T1.2 legacy URL retirement', () => {
    const harnessRoute = readFileSync(join(REPO, 'apps/operator/app/api/_hono/harness.ts'), 'utf8');
    const consumer = readFileSync(join(REPO, 'libs/agent-chat/src/useHarnessChatRuntime.ts'), 'utf8');

    it('no /:slug/architect/chat in harness.ts', () => {
      expect(/harness\.post\(['"]\/:?slug\/architect\/chat['"]/.test(harnessRoute)).toBe(false);
    });
    it('no /:slug/brainstorm/chat in harness.ts', () => {
      expect(/harness\.post\(['"]\/:?slug\/brainstorm\/chat['"]/.test(harnessRoute)).toBe(false);
    });
    it('useHarnessChatRuntime POSTs /api/agent-tools/ not /api/harness/<slug>/', () => {
      expect(consumer).toMatch(/\/api\/agent-tools\//);
      expect(consumer).not.toMatch(/\/api\/harness\/\$\{slug\}\/\$\{endpoint\}/);
    });
    it('useHarnessChatRuntime sends harnessSlug in body', () => {
      expect(consumer).toMatch(/harnessSlug:\s*slug/);
    });
  });
});
