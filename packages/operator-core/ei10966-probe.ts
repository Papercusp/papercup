import './lib/agent-tools/index';
import { listAllProjectedTools } from '@papercusp/tooldef';
const tools = listAllProjectedTools() as unknown as Array<{ name?: string; description?: string; guidance?: Record<string, unknown> }>;
console.log(`[import-probe] ${tools.length} tools projected`);
process.exit(0);
