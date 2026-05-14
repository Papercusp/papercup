/**
 * MCP Resource: papercusp://docs/index
 *
 * Concrete (single-URI) resource that returns the same sitemap as
 * `/llms.txt` — a flat list of section/page title + URL + description.
 * Cheap discovery payload for MCP clients (Cursor, Claude Desktop,
 * etc.) that prefer browsable resources over tool calls.
 */

import { defineResource } from '@papercusp/agent-mcp';
import type { ResourceContents } from '@papercusp/agent-mcp';
import { internalSource as source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';

export default defineResource({
  name: 'docs:index',
  uri: 'papercusp://docs/index',
  capability: 'docs:read',
  mimeType: 'text/plain',
  description:
    'Project documentation sitemap — flat list of every page with title, URL, and description (the /llms.txt content).',

  async read(uri): Promise<ResourceContents> {
    return {
      uri,
      mimeType: 'text/plain',
      text: llms(source as never).index(),
    };
  },
});
