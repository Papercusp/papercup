(async () => {
  await import('@papercusp/operator-core/lib/agent-tools/index');
  const { listMcpProjections } = await import('@papercusp/tooldef');
  const bytes = (a:any[]) => a.reduce((n,t)=> n + JSON.stringify(t).length, 0);
  const all = listMcpProjections();
  const scoper = listMcpProjections('scoper' as any);
  const worker = listMcpProjections('worker' as any);
  const bee = listMcpProjections('bee' as any);
  console.log('ALL    count=%d bytes=%d (~%dk tok)', all.length, bytes(all), Math.round(bytes(all)/4000));
  console.log('SCOPER count=%d bytes=%d (~%dk tok)', scoper.length, bytes(scoper), Math.round(bytes(scoper)/4000));
  console.log('WORKER count=%d bytes=%d (~%dk tok)', worker.length, bytes(worker), Math.round(bytes(worker)/4000));
  console.log('BEE    count=%d bytes=%d (~%dk tok)', bee.length, bytes(bee), Math.round(bytes(bee)/4000));
  const top = scoper.map((t:any)=>[t.name, JSON.stringify(t).length]).sort((a:any,b:any)=>b[1]-a[1]).slice(0,12);
  console.log('TOP scoper tools by bytes:'); for (const [n,b] of top) console.log('  ', b, n);
})().catch(e=>{console.error('ERR', e?.stack||e?.message||e); process.exit(1)});
