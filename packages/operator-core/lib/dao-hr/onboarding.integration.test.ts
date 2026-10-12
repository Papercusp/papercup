/** Real Postgres + signed V2 EVM transactions. Provider completion is a fixture,
 * so this suite is tree evidence and never claims live Documenso acceptance. */
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { bytesToHex, createAddressFromString } from '@ethereumjs/util';
import type { Hex, Address } from 'viem';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { equityV2Evm } from '../equity/evm-test-helpers';
import { unsafeFederatedPotScope } from '../federated-pot-scope';
import { listHiveMembers, upsertHiveMember } from '../hive-membership-store';
import { grantDaoHrAdmin, installSampleTemplates } from './contract-templates';
import { addHiringCandidate, approveHiringOffer, createHiringOffer, createHiringRole, getHiringOffer, listHiringHistory } from './hiring';
import { completeContractSigning, prepareContractExecution, startContractSigning } from './contracts-esign';
import { DocumensoAdapter } from './documenso';
import { getWorkProfile } from './work-profile';
import { DEFAULT_EQUITY_POLICY, resolveOfferTermsFrom, updateEquityPolicy } from './equity-policy';
import { admitHire, onboardingChecklist, prepareHireAcceptance, prepareHireProposal, recordHireExecution, recordHireProposal, reconcileFailedHire, verifyOnboardingIdentity,
  type CandidateIdentity, type OnboardingChain, type OnboardingContract, type OnboardingDeps } from './onboarding';
import type { HivePolicy } from '../hive-policy-schema';

const key={workspaceId:'ws-onboarding',daoSlug:'onboarding-dao'},secret='fixture-secret-longer-than-24-characters';
let db:OrgTestDb,e:Awaited<ReturnType<typeof equityV2Evm>>,roleId:string,policy:HivePolicy,chain:OnboardingChain;
const scope=unsafeFederatedPotScope(key.daoSlug,'Test writes and reads the same synthetic owner scope');
const candidate:CandidateIdentity={githubUserId:42,githubLogin:'new-member',verifiedEmails:['candidate@example.test']};
const wallet=(index=1)=>async()=>({ok:true as const,status:200,value:{bound:true,binding:{walletAddress:e.accounts[index],chainId:1,challengeId:'signed-server-challenge',verifiedAtMs:Date.now()}}});
const deps=():OnboardingDeps=>({sql:db.adminSql,chain,identity:async()=>candidate,wallet:wallet(),adminPerson:async()=> 'PER-author',scope:async()=>scope});
const confirm=()=>{e.advance(1);e.advance(1);};
const row=async(offerId:string)=>(await db.adminSql<OnboardingContract[]>`SELECT * FROM harness_shared.dao_hr_contracts WHERE offer_id=${offerId}`)[0]!;
async function signedOffer(personId='PER-candidate') {
  await addHiringCandidate({...key,roleId,personId,actorPersonId:'PER-author'},{sql:db.adminSql});
  const offer=await createHiringOffer({...key,roleId,personId,actorPersonId:'PER-author',engagementType:'employee',jurisdiction:'US-DE',pay:{amount:'5000',currency:'USD',cadence:'monthly'},overrides:{shares:1000}},{sql:db.adminSql});
  await approveHiringOffer({...key,offerId:offer.offerId,actorPersonId:'PER-reviewer'},{sql:db.adminSql});
  let contract=await prepareContractExecution({...key,offerId:offer.offerId,actorPersonId:'PER-author',companyPersonId:'PER-reviewer',startDate:'2026-11-01',templates:[{templateKey:'sample-employment-agreement-employee-us-de',version:1},{templateKey:'sample-equity-grant-agreement-employee-us-de',version:1}]},{sql:db.adminSql});
  const envelope='envelope-'+contract.contract_id;
  const provider=new DocumensoAdapter({baseUrl:'https://provider.example.test',apiKey:'fixture',webhookSecret:secret},async(url)=>{
    const path=new URL(String(url)).pathname;
    if(path.endsWith('/create'))return Response.json({id:envelope});
    if(path.endsWith('/distribute'))return Response.json({id:envelope,recipients:contract.signers.map((s,i)=>({email:s.email,signingUrl:'https://provider.example.test/sign/'+i}))});
    if(path.endsWith('/download'))return new Response(new Uint8Array(contract.source_pdf),{headers:{'Content-Type':'application/pdf'}});
    return Response.json({id:envelope,externalId:contract.contract_id,status:'COMPLETED',completedAt:'2026-10-11T20:00:00Z',recipients:contract.signers.map(s=>({...s,role:'SIGNER',signingStatus:'SIGNED',signedAt:'2026-10-11T19:00:00Z',authOptions:{accessAuth:['ACCOUNT']}})),envelopeItems:[{id:'item'}]});
  });
  contract=await startContractSigning({...key,offerId:offer.offerId,actorPersonId:'PER-author'},{sql:db.adminSql,adapter:provider});
  await completeContractSigning(secret,{event:'DOCUMENT_COMPLETED',createdAt:'2026-10-11T20:00:00Z',payload:{envelopeId:envelope,externalId:contract.contract_id,status:'COMPLETED'}},{sql:db.adminSql,adapter:provider});
  return {...key,offerId:offer.offerId};
}
beforeAll(async()=>{
  // Cheap automatic fixture preflight runs before any DB/EVM allocation.
  expect(resolveOfferTermsFrom({...DEFAULT_EQUITY_POLICY,startRule:'hire_passed'},1,{role:'Engineer',level:'L3',overrides:{shares:1000}}).startRule).toBe('hire_passed');
  db=await createOrgTestDb();e=await equityV2Evm();
  await db.adminSql`INSERT INTO harness_shared.pots (workspace_id,pot_home_slug) VALUES (${key.workspaceId},${key.daoSlug})`;
  expect(await db.adminSql`SELECT pot_home_slug FROM harness_shared.pots WHERE workspace_id=${key.workspaceId} AND pot_home_slug=${key.daoSlug}`).toHaveLength(1);
  for(const file of ['1462-dao-hr-hiring.sql','1463-dao-hr-contracts-esign.sql','1464-dao-hr-onboarding-proof.sql']){
    const path=new URL('../../../../libs/papercusp/libs/db/sql/'+file,import.meta.url);
    await db.adminSql.unsafe(readFileSync(existsSync(path)?path:new URL(path.href+'.DRAFT'),'utf8'));
  }
  for(const [id,title,email] of [['PER-author','Author','author@example.test'],['PER-reviewer','Reviewer','reviewer@example.test'],['PER-candidate','Candidate','candidate@example.test'],['PER-second','Other candidate','second@example.test']])
    await db.adminSql`INSERT INTO harness_shared.work_items (workspace_id,harness_slug,feature_id,item_kind,title,payload) VALUES (${key.workspaceId},'papercusp',${id!},'person',${title!},${db.adminSql.json({email})})`;
  await grantDaoHrAdmin({...key,personId:'PER-author',bootstrapOperator:'fixture'},{sql:db.adminSql});
  await grantDaoHrAdmin({...key,personId:'PER-reviewer',grantedBy:'PER-author'},{sql:db.adminSql});
  await installSampleTemplates({...key,actorPersonId:'PER-author'},{sql:db.adminSql});
  await updateEquityPolicy({...key,actorPersonId:'PER-author',changes:{startRule:'hire_passed'}},{sql:db.adminSql});
  roleId=(await createHiringRole({...key,actorPersonId:'PER-author',title:'Engineer',level:'L3'},{sql:db.adminSql})).roleId;
  policy={finance:{equity:{chainId:1,equity:e.equity.address,governor:e.governor.address,timelock:e.timelock.address}}} as HivePolicy;
  chain={getChainId:async()=>1,getBlockNumber:async()=>e.blockNumber(),getCode:async({address})=>bytesToHex(await e.vm.stateManager.getCode(createAddressFromString(address))),
    readContract:async({address,abi,functionName,args})=>e.read({address:address as Address,abi},functionName,args),getTransaction:e.getTransaction,getTransactionReceipt:e.getTransactionReceipt,getBlock:e.getBlock};
},180_000);
afterAll(async()=>{await db?.cleanup();});
describe('P007 — identity, one hire vote, acceptance and membership',()=>{
  it('rejects a foreign signer identity, unverified hosted binding and duplicate wallet before saving any link',async()=>{
    const k=await signedOffer();
    await expect(verifyOnboardingIdentity(k,{...deps(),identity:async()=>({...candidate,verifiedEmails:['stranger@example.test']})})).rejects.toMatchObject({code:'identity_mismatch'});
    await expect(verifyOnboardingIdentity(k,{...deps(),wallet:async()=>({ok:true,status:200,value:{binding:{walletAddress:e.accounts[1],chainId:1}}})})).rejects.toMatchObject({code:'wallet_unverified'});
    expect((await row(k.offerId)).candidate_github_id).toBeNull();
    expect(await getWorkProfile({...key,personId:'PER-candidate'},{sql:db.adminSql})).toBeNull();
    await verifyOnboardingIdentity(k,deps());
    const second=await signedOffer('PER-second');
    await expect(verifyOnboardingIdentity(second,{...deps(),identity:async()=>({githubUserId:43,githubLogin:'second',verifiedEmails:['second@example.test']})})).rejects.toThrow();
    expect(await getWorkProfile({...key,personId:'PER-second'},{sql:db.adminSql})).toBeNull();
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET candidate_github_id=99 WHERE offer_id=${k.offerId}`).rejects.toThrow('immutable');
  });
  it('uses product unsigned calldata on the EVM; pending, unrelated and unaccepted hires never admit; replay admits once without a second proposal',async()=>{
    const [existing]=await db.adminSql<Array<{offer_id:string}>>`SELECT offer_id FROM harness_shared.dao_hr_contracts WHERE candidate_github_id=42`;
    const k={...key,offerId:existing!.offer_id},d=deps(),admin={...d,wallet:wallet(0)};
    const prepared=await prepareHireProposal(k,policy,admin);
    // jsonb reorders keys: replay must return the identical frozen plan.
    expect((await prepareHireProposal(k,policy,admin)).plan.proposalId).toBe(prepared.plan.proposalId);
    await expect(db.adminSql`UPDATE harness_shared.dao_hr_contracts SET hire_plan='{}'::jsonb WHERE offer_id=${k.offerId}`).rejects.toThrow('immutable');
    await expect(prepareHireAcceptance(k,policy,d)).rejects.toMatchObject({code:'invalid_stage'});
    await expect(admitHire(k,policy,('0x'+'00'.repeat(32)) as Hex,d)).rejects.toMatchObject({code:'invalid_stage'});
    expect(await listHiveMembers(key.workspaceId,scope,db.adminSql)).toHaveLength(0);
    const creation=await e.raw(prepared.unsignedTransaction.data,prepared.unsignedTransaction.to,0,e.governor.abi);confirm();
    await recordHireProposal(k,policy,creation.transactionHash,admin);
    await expect(reconcileFailedHire(k,policy,admin)).rejects.toMatchObject({code:'invalid_stage'});
    const p=prepared.plan;
    await e.finish({targets:p.targets,values:p.values.map(BigInt),calldatas:p.calldatas,descriptionHash:p.descriptionHash,id:BigInt(p.proposalId)});
    const execution=e.lastTransactionHash()!;confirm();
    await expect(recordHireExecution(k,policy,creation.transactionHash,d)).rejects.toMatchObject({code:'invalid_proof'});
    await recordHireExecution(k,policy,execution,d);
    expect((await row(k.offerId)).state).toBe('signed'); // sample cannot become legally binding
    const stored=await e.read(e.equity,'grants',[p.grantId]) as unknown[];
    expect(String(stored[3])).toBe(String((await e.getBlock({blockNumber:BigInt((await row(k.offerId)).hire_execution_proof!.blockNumber)})).timestamp));
    const acceptance=await prepareHireAcceptance(k,policy,d);
    await expect(admitHire(k,policy,execution,d)).rejects.toMatchObject({code:'invalid_proof'});
    expect(await listHiveMembers(key.workspaceId,scope,db.adminSql)).toHaveLength(0);
    const accepted=await e.raw(acceptance.data,acceptance.to,1,e.equity.abi);confirm();
    const proposalsBefore=await e.getContractEvents({address:e.governor.address,abi:e.governor.abi,eventName:'ProposalCreated',fromBlock:0n,toBlock:e.blockNumber()});
    const admit=vi.fn(upsertHiveMember);
    await admitHire(k,policy,accepted.transactionHash,{...d,admit});
    await admitHire(k,policy,accepted.transactionHash,{...d,admit});
    expect(admit).toHaveBeenCalledTimes(1);
    expect((await listHiveMembers(key.workspaceId,scope,db.adminSql)).map(m=>m.githubUserId)).toEqual([42]);
    const profile=await getWorkProfile({...key,personId:p.personId},{sql:db.adminSql});
    expect(profile?.status).toBe('active');expect(onboardingChecklist(await row(k.offerId),profile).every(s=>s.complete)).toBe(true);
    expect((await getHiringOffer(k,{sql:db.adminSql})).state).toBe('hired');
    expect((await listHiringHistory({...k,subjectKind:'offer',subjectId:k.offerId},{sql:db.adminSql})).filter(h=>h.state==='hired')).toHaveLength(1);
    const proposalsAfter=await e.getContractEvents({address:e.governor.address,abi:e.governor.abi,eventName:'ProposalCreated',fromBlock:0n,toBlock:e.blockNumber()});
    expect(proposalsAfter).toEqual(proposalsBefore);
  },120_000);
  it('a defeated hire lapses the conditional contract and refuses acceptance or admission',async()=>{
    const k=await signedOffer('PER-second');
    const d={...deps(),identity:async()=>({githubUserId:43,githubLogin:'second',verifiedEmails:['second@example.test']}),wallet:wallet(2)};
    await verifyOnboardingIdentity(k,d);
    const admin={...d,wallet:wallet(0)},prepared=await prepareHireProposal(k,policy,admin);
    const created=await e.raw(prepared.unsignedTransaction.data,prepared.unsignedTransaction.to,0,e.governor.abi);confirm();
    await recordHireProposal(k,policy,created.transactionHash,admin);
    e.advance(86400+120);
    await expect(reconcileFailedHire(k,policy,admin)).resolves.toEqual({state:'lapsed'});
    expect((await row(k.offerId)).state).toBe('lapsed');
    await expect(prepareHireAcceptance(k,policy,d)).rejects.toMatchObject({code:'invalid_stage'});
    await expect(admitHire(k,policy,created.transactionHash,d)).rejects.toMatchObject({code:'invalid_stage'});
    expect((await listHiveMembers(key.workspaceId,scope,db.adminSql)).map(m=>m.githubUserId)).toEqual([42]);
    expect(onboardingChecklist(await row(k.offerId),await getWorkProfile({...key,personId:'PER-second'},{sql:db.adminSql})).slice(3).every(s=>!s.complete)).toBe(true);
  },120_000);
});
