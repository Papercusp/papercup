import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { grantDaoHrAdmin, installSampleTemplates } from './contract-templates';
import { addHiringCandidate, approveHiringOffer, createHiringOffer, createHiringRole, getHiringOffer, listHiringHistory, requireHiringStage } from './hiring';
import { completeContractSigning, getContractExecution, prepareContractExecution, startContractSigning, type ContractExecution } from './contracts-esign';
import { DocumensoAdapter } from './documenso';

const key={workspaceId:'ws-contract-signing',daoSlug:'contract-dao'},secret='test-fixture-secret-at-least-24-characters';
let db:OrgTestDb,roleId:string,completion:ContractExecution;
let sent=0;
const templates=[{templateKey:'sample-employment-agreement-employee-us-de',version:1},{templateKey:'sample-equity-grant-agreement-employee-us-de',version:1}];
const offer=()=>createHiringOffer({...key,roleId,personId:'PER-candidate',actorPersonId:'PER-author',engagementType:'employee',jurisdiction:'US-DE',pay:{amount:'5000.25',currency:'USD',cadence:'monthly'},overrides:{shares:1000}},{sql:db.adminSql});
const prepare=(offerId:string)=>prepareContractExecution({...key,offerId,actorPersonId:'PER-author',companyPersonId:'PER-reviewer',startDate:'2026-11-01',templates},{sql:db.adminSql});
const event=(row:ContractExecution)=>({event:'DOCUMENT_COMPLETED',createdAt:'2026-10-11T20:00:00.000Z',payload:{envelopeId:row.envelope_id,externalId:row.contract_id,status:'COMPLETED'}});
const adapter=()=>new DocumensoAdapter({baseUrl:'https://signing.example.test',apiKey:'fixture-key',webhookSecret:secret},async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path.endsWith('/create')){sent++;return Response.json({id:'envelope-'+sent});}
  if(path.endsWith('/distribute')){
    const body=JSON.parse(String(init?.body));
    return Response.json({id:body.envelopeId,recipients:completion.signers.map((s,i)=>({email:s.email,signingUrl:'https://signing.example.test/sign/'+i}))});
  }
  if(path.endsWith('/download'))return new Response(new Uint8Array(completion.source_pdf),{headers:{'Content-Type':'application/pdf'}});
  return Response.json({id:completion.envelope_id,externalId:completion.contract_id,status:'COMPLETED',completedAt:'2026-10-11T20:00:00.000Z',
    recipients:completion.signers.map(s=>({...s,role:'SIGNER',signingStatus:'SIGNED',signedAt:'2026-10-11T19:00:00.000Z',authOptions:{accessAuth:['ACCOUNT']}})),envelopeItems:[{id:'item'}]});
});
beforeAll(async()=>{
  db=await createOrgTestDb();
  for(const file of ['1462-dao-hr-hiring.sql','1463-dao-hr-contracts-esign.sql']){
    const path=new URL('../../../../libs/papercusp/libs/db/sql/'+file,import.meta.url);
    await db.adminSql.unsafe(readFileSync(existsSync(path)?path:new URL(path.href+'.DRAFT'),'utf8'));
  }
  for(const [id,label,email] of [['PER-author','Author','author@example.test'],['PER-reviewer','Company signer','company@example.test'],['PER-candidate','Candidate','candidate@example.test']])
    await db.adminSql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,title,payload) VALUES (${key.workspaceId},'papercusp',${id!},'person',${label!},${db.adminSql.json({email})})`;
  await grantDaoHrAdmin({...key,personId:'PER-author',bootstrapOperator:'fixture'},{sql:db.adminSql});
  await grantDaoHrAdmin({...key,personId:'PER-reviewer',grantedBy:'PER-author'},{sql:db.adminSql});
  await installSampleTemplates({...key,actorPersonId:'PER-author'},{sql:db.adminSql});
  roleId=(await createHiringRole({...key,actorPersonId:'PER-author',title:'Engineer',level:'L3'},{sql:db.adminSql})).roleId;
  await addHiringCandidate({...key,roleId,personId:'PER-candidate',actorPersonId:'PER-author'},{sql:db.adminSql});
},180_000);
afterAll(async()=>{await db?.cleanup();});
describe('P006 — persisted signing execution (schema-derived provider simulation; not live Documenso proof)',()=>{
  it('gates generation on approval, freezes exact offer merges and stamps sample eligibility',async()=>{
    const saved=await offer();
    await expect(prepare(saved.offerId)).rejects.toMatchObject({code:'invalid_transition'});
    await approveHiringOffer({...key,offerId:saved.offerId,actorPersonId:'PER-reviewer'},{sql:db.adminSql});
    completion=await prepare(saved.offerId);
    expect(completion.can_bind).toBe(false);expect(completion.state).toBe('prepared');
    expect(completion.merge_values).toMatchObject({pay_amount:'5000.25',share_amount:'1000',vesting_days:String(saved.terms.equity.vestingDays)});
    expect((await getHiringOffer({...key,offerId:saved.offerId},{sql:db.adminSql})).state).toBe('contract-generated');
    await expect(requireHiringStage({...key,offerId:saved.offerId,stage:'hire'},{sql:db.adminSql})).rejects.toMatchObject({code:'invalid_transition'});
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET merge_values='{}'::jsonb WHERE contract_id=${completion.contract_id}`).rejects.toThrow('immutable');
    expect((await prepare(saved.offerId)).contract_id).toBe(completion.contract_id);
  });
  it('single dispatch persists the envelope, completion stores both artifacts and SHA256, replay writes one signed transition',async()=>{
    const provider=adapter(),input={...key,offerId:completion.offer_id,actorPersonId:'PER-author'};
    completion=await startContractSigning(input,{sql:db.adminSql,adapter:provider});
    expect(completion.state).toBe('signing');expect(sent).toBe(1);
    await startContractSigning(input,{sql:db.adminSql,adapter:provider});expect(sent).toBe(1);
    await expect(completeContractSigning('wrong',event(completion),{sql:db.adminSql,adapter:provider})).rejects.toMatchObject({code:'invalid_webhook'});
    completion=await completeContractSigning(secret,event(completion),{sql:db.adminSql,adapter:provider});
    expect(completion.state).toBe('signed');expect(completion.can_bind).toBe(false);
    expect(completion.document_hash).toBe('0x'+createHash('sha256').update(completion.sealed_pdf!).digest('hex'));
    expect(completion.audit_certificate!.length).toBeGreaterThan(100);
    await completeContractSigning(secret,event(completion),{sql:db.adminSql,adapter:provider});
    await expect(requireHiringStage({...key,offerId:completion.offer_id,stage:'hire'},{sql:db.adminSql})).resolves.toMatchObject({state:'signed'});
    const events=await listHiringHistory({...key,subjectKind:'offer',subjectId:completion.offer_id},{sql:db.adminSql});
    expect(events.filter(e=>e.state==='signed')).toHaveLength(1);expect(events.at(-1)?.actor_person_id).toBe('PER-reviewer');
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET document_hash=${'0x'+'00'.repeat(32)} WHERE contract_id=${completion.contract_id}`).rejects.toThrow('immutable');
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET state='binding' WHERE contract_id=${completion.contract_id}`).rejects.toThrow();
  });
  it('retains an ambiguous create as dispatching and refuses a blind duplicate',async()=>{
    const saved=await offer();await approveHiringOffer({...key,offerId:saved.offerId,actorPersonId:'PER-reviewer'},{sql:db.adminSql});
    await prepare(saved.offerId);
    let attempts=0;const provider=new DocumensoAdapter({baseUrl:'https://signing.example.test',apiKey:'fixture-key',webhookSecret:secret},async()=>{attempts++;throw new Error('network outcome unknown');});
    const input={...key,offerId:saved.offerId,actorPersonId:'PER-author'};
    await expect(startContractSigning(input,{sql:db.adminSql,adapter:provider})).rejects.toThrow('network outcome unknown');
    expect((await getContractExecution(input,{sql:db.adminSql})).state).toBe('dispatching');
    await expect(startContractSigning(input,{sql:db.adminSql,adapter:provider})).rejects.toMatchObject({code:'dispatch_unknown'});expect(attempts).toBe(1);
  });
});
