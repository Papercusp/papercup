import { describe, expect, it } from 'vitest';
import { EXPORT_MAX_AGE_MS, judgeExportHealth, judgeRestore, RESTORE_DEADLINE_MS, restoreDrill } from './backup-restore-drill';
import { makeCtx, type GcloudRunner } from './provision-cloud-sql';

describe('completed export freshness (WI-10000694 recurrence guard)', () => {
  const now = Date.parse('2026-10-14T20:00:00Z');
  const op = (database: string, age: number, overrides = {}) => ({ status: 'DONE', endTime: new Date(now-age).toISOString(),
    exportContext: { fileType: 'SQL', databases: [database], uri: `gs://separate-backup/${database}/dump.sql.gz` }, ...overrides });
  it('requires a fresh successful export for every database', () => {
    expect(judgeExportHealth(['hosted','portal','dbos'], [op('hosted',1),op('portal',1),op('dbos',1)], 'separate-backup',now).ok).toBe(true);
    expect(judgeExportHealth(['hosted','portal','dbos'], [op('hosted',1),op('portal',1)], 'separate-backup',now).stale).toEqual(['dbos']);
  });
  it('detects old data even when a plausible artifact and newer failed attempt exist', () => {
    const health = judgeExportHealth(['hosted'], [op('hosted',EXPORT_MAX_AGE_MS+1),op('hosted',1,{error:{errors:[{code:'FAILED'}]}})], 'separate-backup',now);
    expect(health.ok).toBe(false);
    expect(health.stale).toEqual(['hosted']);
  });
  it('ignores pending, malformed, future and wrong-storage operations', () => {
    const candidates = [op('hosted',1,{status:'RUNNING'}),op('hosted',-1),op('hosted',1,{endTime:'bad'}),
      op('hosted',1,{exportContext:{fileType:'SQL',databases:['hosted'],uri:'gs://prod/backup.sql.gz'}})];
    expect(judgeExportHealth(['hosted'],candidates,'separate-backup',now)).toEqual({ok:false,stale:['hosted'],latest:{}});
  });
});

describe('PITR verdict', () => {
  it('discriminates a point-in-time restore from a current-state clone', () => {
    const good = {beforeRows:1,afterRows:0,rtoMs:1000,rpoMs:2000};
    expect(judgeRestore(good)).toBe(true);
    expect(judgeRestore({...good,afterRows:1})).toBe(false);
    expect(judgeRestore({...good,beforeRows:0})).toBe(false);
    expect(judgeRestore({...good,rtoMs:RESTORE_DEADLINE_MS+1})).toBe(false);
    expect(judgeRestore({...good,rtoMs:NaN})).toBe(false);
  });
});

function fake(options: { existing?: boolean; failedClone?: boolean; afterRows?: number; cleanupFails?: boolean } = {}) {
  const calls: string[][] = [];
  let scratchProtection = true;
  const json = (body: unknown) => ({code:0,stdout:JSON.stringify(body),stderr:''});
  const instance = (name: string) => ({name,state:'RUNNABLE',settings:{backupConfiguration:{enabled:true,pointInTimeRecoveryEnabled:true},
    dataApiAccess:'DISALLOW_DATA_API',deletionProtectionEnabled:name.startsWith('pc-pitr-drill') ? scratchProtection : true,
    ipConfiguration:{ipv4Enabled:false,privateNetwork:'private-net'}}});
  const gcloud: GcloudRunner = async args => {
    calls.push([...args]);
    if (args.slice(0,3).join(' ') === 'sql instances describe') {
      if (args[3]?.startsWith('pc-pitr-drill') && !calls.some(c=>c[2]==='clone')) {
        return options.existing ? json(instance(args[3])) : {code:1,stdout:'',stderr:'NOT_FOUND'};
      }
      return json(instance(args[3]!));
    }
    if (args[2]==='get-latest-recovery-time') return json({earliestRecoveryTime:'2026-10-14T00:00:00Z',latestRecoveryTime:'2026-10-14T20:00:00Z'});
    if (args[2]==='clone') return json({name:'operation-1'});
    if (args[2]==='patch' && args[3]?.startsWith('pc-pitr-drill') && args.includes('--no-deletion-protection')) scratchProtection = false;
    if (args[2]==='delete' && scratchProtection) return {code:1,stdout:'',stderr:'instance is protected'};
    if (args.slice(0,3).join(' ')==='sql operations describe') return json(options.failedClone ? {status:'DONE',error:{errors:[{code:'FAILED'}]}} : {status:'DONE'});
    if (args[2]==='execute-sql') {
      const statement = args.find(a=>a.startsWith('--sql='))!;
      if (statement.includes('DROP SCHEMA') && options.cleanupFails) return {code:1,stdout:'',stderr:'private details'};
      const cell = statement.includes('restorePoint') ? {restorePoint:'2026-10-14T19:59:00Z'} : {beforeRows:1,afterRows:options.afterRows??0};
      return json({results:[{rows:[{values:[{value:JSON.stringify(cell)}]}]}]});
    }
    return json({});
  };
  const ctx = makeCtx({gcloud,sleep:async()=>{},log:()=>{}});
  return {ctx,calls};
}

describe('drill orchestration safety', () => {
  const nonce='aabbccddeeff';
  it('restores to a separate instance and cleans its own resources', async () => {
    const f=fake();
    const receipt=await restoreDrill({ctx:f.ctx,nonce,now:()=>Date.parse('2026-10-14T20:01:00Z')});
    expect(receipt.passed).toBe(true);
    expect(receipt.cleanup).toEqual({sourceCanaryRemoved:true,sourceDataApiClosed:true,scratchDeleted:true});
    const clone=f.calls.find(c=>c[2]==='clone')!;
    expect(clone).toContain('--point-in-time=2026-10-14T19:59:00Z');
    expect(clone.slice(3,5)).toEqual(['pc-cloud-prod-pg','pc-pitr-drill-aabbccddeeff']);
    expect(f.calls.filter(c=>c[2]==='delete').map(c=>c[3])).toEqual(['pc-pitr-drill-aabbccddeeff']);
    const clearing=f.calls.filter(c=>c.includes('--no-deletion-protection'));
    expect(clearing).toHaveLength(1);
    expect(clearing[0]![3]).toBe('pc-pitr-drill-aabbccddeeff');
    expect(clearing[0]).toContain('--data-api-access=DISALLOW_DATA_API');
  });
  it('refuses an existing scratch instance before mutating anything', async () => {
    const f=fake({existing:true});
    await expect(restoreDrill({ctx:f.ctx,nonce})).rejects.toThrow('scratch_already_exists');
    expect(f.calls.every(c=>c[2]==='describe')).toBe(true);
  });
  it.each([{failedClone:true},{afterRows:1}])('cleans even when restore verification fails: %j', async options => {
    const f=fake(options);
    await expect(restoreDrill({ctx:f.ctx,nonce,now:()=>Date.parse('2026-10-14T20:01:00Z')})).rejects.toThrow(/clone_failed|verification_failed/);
    expect(f.calls.some(c=>c[2]==='delete')).toBe(true);
    expect(f.calls.some(c=>c.includes('--data-api-access=DISALLOW_DATA_API'))).toBe(true);
    expect(f.calls.some(c=>c.some(a=>a.includes('DROP SCHEMA')))).toBe(true);
  });
  it('continues independent cleanup and reports residue when canary cleanup fails', async () => {
    const f=fake({cleanupFails:true});
    await expect(restoreDrill({ctx:f.ctx,nonce,now:()=>Date.parse('2026-10-14T20:01:00Z')})).rejects.toThrow('cleanup_incomplete:source_canary_cleanup_failed');
    expect(f.calls.some(c=>c[2]==='delete')).toBe(true);
    expect(f.calls.filter(c=>c[2]==='patch').at(-1)).toContain('--data-api-access=DISALLOW_DATA_API');
  });
});
