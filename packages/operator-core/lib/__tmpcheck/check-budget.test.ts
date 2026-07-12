import { it } from 'vitest';
import '../agent-tools/index';
import { listAllProjectedTools } from '@papercusp/tooldef';

it('print', () => {
  const tools = listAllProjectedTools() as any[];
  const t = tools.find(t => t.expose?.mcp?.name === 'rubrics:propose');
  const g = t.guidance ?? {};
  console.log('desc', t.description?.length);
  console.log('when', g.when?.length);
  console.log('notWhen', g.notWhen?.length);
  console.log('chaining', g.chaining?.length);
});
