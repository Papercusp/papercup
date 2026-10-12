import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
const io=vi.hoisted(()=>({actor:vi.fn(),templates:vi.fn(),get:vi.fn(),prepare:vi.fn(),start:vi.fn(),complete:vi.fn(),origin:vi.fn(),onboarding:vi.fn(),identity:vi.fn(),hire:vi.fn(),accept:vi.fn(),admit:vi.fn(),wallet:vi.fn(),execution:vi.fn()}));
vi.mock('../../../workspace-registry',()=>({activeWorkspaceId:()=> 'workspace'}));
vi.mock('../../../dao-hr/contract-templates',async original=>({...await original<typeof import('../../../dao-hr/contract-templates')>(),listContractTemplates:io.templates}));
vi.mock('../../../dao-hr/hiring',async original=>({...await original<typeof import('../../../dao-hr/hiring')>(),resolveHiringActor:io.actor}));
vi.mock('../../../dao-hr/contracts-esign',async original=>({...await original<typeof import('../../../dao-hr/contracts-esign')>(),getContractExecution:io.get,prepareContractExecution:io.prepare,startContractSigning:io.start,completeContractSigning:io.complete}));
vi.mock('../../cors',()=>({requireAllowedOriginOr403:io.origin}));
vi.mock('../../../federated-pot-scope',()=>({resolveFederatedPotScope:async()=> 'dao'}));
vi.mock('../../../hive-policy-store',()=>({getHivePolicy:async()=>({policy:{}})}));
vi.mock('../../../dao-hr/onboarding',async original=>({...await original<typeof import('../../../dao-hr/onboarding')>(),readOnboarding:io.onboarding,verifyOnboardingIdentity:io.identity,prepareHireProposal:io.hire,prepareHireAcceptance:io.accept,admitHire:io.admit,runOnboardingWalletAction:io.wallet,recordHireExecution:io.execution}));
import routes from './contracts';
import { HiringError } from '../../../dao-hr/hiring';
import { DocumensoError } from '../../../dao-hr/documenso';
import { ContractSigningError } from '../../../dao-hr/contracts-esign';
import { OnboardingError } from '../../../dao-hr/onboarding';
const ctx:RouteContext={params:{id:'dao',offerId:'offer'},principal:null,input:undefined,log:()=>{},signal:new AbortController().signal};
const request=(body:unknown)=>new Request('http://local/api/pot/dao/contracts',{method:'POST',body:JSON.stringify(body)});
describe('Contract execution HTTP boundary',()=>{
  beforeEach(()=>{Object.values(io).forEach(mock=>mock.mockReset());io.actor.mockResolvedValue('PER-admin');io.templates.mockResolvedValue([]);});
  it('keeps private routes loopback and only the secret-checked provider completion route public',()=>{
    expect(routes.map(r=>r.auth)).toEqual(['loopback','loopback','loopback','public','loopback','loopback']);
  });
  it('refuses a non-admin before reading templates or contract bytes',async()=>{
    io.actor.mockRejectedValue(new HiringError('not_admin','Sign in as HR admin'));
    expect((await routes[0]!.handler(new Request('http://local'),ctx)).status).toBe(403);
    expect(io.templates).not.toHaveBeenCalled();expect(io.get).not.toHaveBeenCalled();
  });
  it('strictly rejects client-controlled actor, source terms or lifecycle setters',async()=>{
    for(const input of [{action:'start',offerId:'offer',actorPersonId:'PER-forged'},{action:'start',offerId:'offer',state:'signed'},{action:'prepare',offerId:'offer',terms:{shares:1000}}])
      expect((await routes[1]!.handler(request(input),ctx)).status).toBe(400);
    expect(io.prepare).not.toHaveBeenCalled();expect(io.start).not.toHaveBeenCalled();
  });
  it('resolves the actor server-side and protects writes against another origin',async()=>{
    io.start.mockResolvedValue({contract_id:'contract',state:'signing'});
    expect((await routes[1]!.handler(request({action:'start',offerId:'offer'}),ctx)).status).toBe(200);
    expect(io.start).toHaveBeenCalledWith({workspaceId:'workspace',daoSlug:'dao',offerId:'offer',action:'start',actorPersonId:'PER-admin'});
    io.origin.mockReturnValue(Response.json({error:'origin'},{status:403}));
    expect((await routes[1]!.handler(request({action:'start',offerId:'offer'}),ctx)).status).toBe(403);expect(io.start).toHaveBeenCalledOnce();
  });
  it('serializes a contract summary without binary documents or signer identity snapshots',async()=>{
    io.get.mockResolvedValue({contract_id:'contract',state:'signed',can_bind:false,document_hash:'hash',completed_at:'date',signing_links:[],templates:[],source_pdf:[1,2],sealed_pdf:[3,4],signers:[{email:'private@example.test'}]});
    const data=await(await routes[0]!.handler(new Request('http://local?offer=offer'),ctx)).json();
    expect(data.execution).toEqual({contractId:'contract',state:'signed',bindingEligible:false,documentHash:'hash',completedAt:'date',signingLinks:[],templates:[]});
  });
  it('downloads only available artifacts with private cache headers',async()=>{
    io.get.mockResolvedValue({source_pdf:new TextEncoder().encode('%PDF-fixture'),sealed_pdf:null,audit_certificate:null});
    const response=await routes[2]!.handler(new Request('http://local?kind=source'),ctx);
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(await response.text()).toBe('%PDF-fixture');
    expect((await routes[2]!.handler(new Request('http://local?kind=sealed'),ctx)).status).toBe(409);
  });
  it('forwards the exact provider secret header and never provides a generic signed-state setter',async()=>{
    io.complete.mockRejectedValue(new DocumensoError('invalid_webhook','Bad secret'));
    const req=new Request('http://local/api/dao-hr/documenso/webhook',{method:'POST',headers:{'X-Documenso-Secret':'bad'},body:'{"event":"DOCUMENT_COMPLETED"}'});
    expect((await routes[3]!.handler(req,ctx)).status).toBe(403);expect(io.complete).toHaveBeenCalledWith('bad',{event:'DOCUMENT_COMPLETED'});
    io.get.mockRejectedValue(new ContractSigningError('contract_missing','Missing'));
  });
  it('allows the verified candidate checklist before membership without exposing HR templates',async()=>{
    io.onboarding.mockResolvedValue({isCandidate:true,isAdmin:false,checklist:[]});
    const response=await routes[4]!.handler(new Request('http://local'),ctx);
    expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json()).onboarding.isCandidate).toBe(true);expect(io.actor).not.toHaveBeenCalled();expect(io.templates).not.toHaveBeenCalled();
  });
  it('refuses foreign candidates and origin attacks before any chain or membership action',async()=>{
    io.onboarding.mockRejectedValue(new OnboardingError('identity_mismatch','Foreign signer'));
    expect((await routes[5]!.handler(request({action:'prepare-hire'}),ctx)).status).toBe(403);expect(io.hire).not.toHaveBeenCalled();
    io.origin.mockReturnValue(Response.json({}, {status:403}));
    expect((await routes[5]!.handler(request({action:'admit',transactionHash:'0x'+'11'.repeat(32)}),ctx)).status).toBe(403);expect(io.admit).not.toHaveBeenCalled();
  });
  it('rejects client identity, deployment, receipts and lifecycle setters',async()=>{
    for(const body of [{action:'verify-identity',githubUserId:42},{action:'prepare-hire',equity:'forged'},{action:'admit',transactionHash:'0x'+'11'.repeat(32),proof:{status:'success'}},{action:'record-execution',transactionHash:'invalid'},{action:'set-state',state:'hired'}])
      expect((await routes[5]!.handler(request(body),ctx)).status).toBe(400);
    expect(io.identity).not.toHaveBeenCalled();expect(io.admit).not.toHaveBeenCalled();expect(io.execution).not.toHaveBeenCalled();
  });
  it('only passes lookup hashes and the signed server policy into admission',async()=>{
    const transactionHash='0x'+'11'.repeat(32);io.admit.mockResolvedValue({transactionHash});
    expect((await routes[5]!.handler(request({action:'admit',transactionHash}),ctx)).status).toBe(200);
    expect(io.admit).toHaveBeenCalledWith({workspaceId:'workspace',daoSlug:'dao',offerId:'offer'},{},transactionHash);
  });
  it('preserves hosted wallet signature refusal without marking identity verified',async()=>{
    io.wallet.mockResolvedValue({ok:false,status:409,error:'invalid_signature'});
    const response=await routes[5]!.handler(request({action:'wallet-verify',challengeId:'challenge',signature:'0x'+'11'.repeat(65)}),ctx);
    expect(response.status).toBe(409);expect((await response.json()).error).toBe('invalid_signature');expect(io.identity).not.toHaveBeenCalled();
  });
});
