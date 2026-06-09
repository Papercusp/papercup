import '@papercusp/operator-core/lib/agent-tools/index.ts';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
const tools: any[] = listAllProjectedTools() as any[];
console.log('total projected tools:', tools.length);
for (const name of ['memory:search', 'memory:remember', 'papercusp:list_workspaces']) {
  const t = tools.find((x: any) => x.name === name || x.mcpName === name || x.expose?.mcp?.name === name);
  if (!t) { console.log(name, '=> NOT FOUND'); continue; }
  const props = t.inputSchema?.properties || t.args?.properties || {};
  console.log(name, '=> crossWorkspace=', t.crossWorkspace, ' workspaceArg=', 'workspace' in props);
}
