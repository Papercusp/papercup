import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteContext } from '@papercusp/agent-mcp';
const io=vi.hoisted(()=>({actor:vi.fn(),templates:vi.fn(),get:vi.fn(),prepare:vi.fn(),start:vi.fn(),complete:vi.fn(),origin:vi.fn()}));
vi.mock('../../../workspace-registry',()=>({activeWorkspaceId:()=> 'workspace'}));
vi.mock('../../../dao-hr/contract-templates',async original=>({...await original<typeof import('../../../dao-hr/contract-templates')>(),listContractTemplates:io.templates}));
vi.mock('../../../dao-hr/hiring',async original=>({...await original<typeof import('../../../dao-hr/hiring')>(),resolveHiringActor:io.actor}));
vi.mock('../../../dao-hr/contracts-esign',async original=>({...await original<typeof import('../../../dao-hr/contracts-esign')>(),getContractExecution:io.get,prepareContractExecution:io.prepare,startContractSigning:io.start,completeContractSigning:io.complete}));
vi.mock('../../cors',()=>({requireAllowedOriginOr403:io.origin}));
import routes from './contracts';
import { HiringError } from '../../../dao-hr/hiring';
import { DocumensoError } from '../../../dao-hr/documenso';
import { ContractSigningError } from '../../../dao-hr/contracts-esign';
const ctx:RouteContext={params:{id:'dao',offerId:'offer'},principal:null,input:undefined,log:()=>{},signal:new AbortController().signal};
const request=(body:unknown)=>new Request('http://local/api/pot/dao/contracts',{method:'POST',body:JSON.stringify(body)});
describe('Contract execution HTTP boundary',()=>{
  beforeEach(()=>{Object.values(io).forEach(mock=>mock.mockReset());io.actor.mockResolvedValue('PER-admin');io.templates.mockResolvedValue([]);});
  it('keeps private routes loopback and only the secret-checked provider completion route public',()=>{
    expect(routes.map(r=>r.auth)).toEqual(['loopback','loopback','loopback','public']);
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
});
