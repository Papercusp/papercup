import { defineTool } from '@papercusp/agent-mcp';
import { z, ZodError } from 'zod';
import { activeWorkspaceId } from '../../../workspace-registry';
import { ContractTemplateError, listContractTemplates } from '../../../dao-hr/contract-templates';
import { HiringError, resolveHiringActor } from '../../../dao-hr/hiring';
import { completeContractSigning, ContractSigningError, getContractExecution, prepareContractExecution, startContractSigning } from '../../../dao-hr/contracts-esign';
import { DocumensoError } from '../../../dao-hr/documenso';
import { requireAllowedOriginOr403 } from '../../cors';

const actions=z.discriminatedUnion('action',[
  z.object({action:z.literal('prepare'),offerId:z.string().min(1),companyPersonId:z.string().min(1),startDate:z.string(),templates:z.array(z.object({templateKey:z.string().min(1),version:z.number().int().positive()}).strict()).min(2).max(4)}).strict(),
  z.object({action:z.literal('start'),offerId:z.string().min(1)}).strict(),
]);
function failure(error:unknown){
  if(error instanceof ZodError)return Response.json({ok:false,error:'invalid_input',message:'Contract fields are missing or invalid.'},{status:400});
  if(error instanceof ContractTemplateError||error instanceof ContractSigningError||error instanceof HiringError||error instanceof DocumensoError)
    return Response.json({ok:false,error:error.code,message:error.message},{status:error.code==='not_admin'||error.code==='invalid_webhook'?403:error.code==='invalid_input'?400:409});
  throw error;
}
const get=defineTool({method:'GET',path:'/pot/:id/contracts',auth:'loopback',async handler(req,ctx){
  const key={workspaceId:activeWorkspaceId(),daoSlug:ctx.params.id!};
  try{
    await resolveHiringActor(key);
    const templates=await listContractTemplates(key),offerId=new URL(req.url).searchParams.get('offer');
    let execution=null;
    if(offerId){
      try{
        const row=await getContractExecution({...key,offerId});
        execution={contractId:row.contract_id,state:row.state,bindingEligible:row.can_bind,documentHash:row.document_hash,completedAt:row.completed_at,signingLinks:row.signing_links,templates:row.templates};
      }catch(error){if(!(error instanceof ContractSigningError&&error.code==='contract_missing'))throw error;}
    }
    return Response.json({ok:true,templates,execution});
  }catch(error){return failure(error);}
}});
const post=defineTool({method:'POST',path:'/pot/:id/contracts',auth:'loopback',async handler(req,ctx){
  const refusal=requireAllowedOriginOr403(req);if(refusal)return refusal;
  try{
    const key={workspaceId:activeWorkspaceId(),daoSlug:ctx.params.id!},actorPersonId=await resolveHiringActor(key),action=actions.parse(await req.json().catch(()=>null));
    const row=action.action==='prepare'?await prepareContractExecution({...key,...action,actorPersonId}):await startContractSigning({...key,...action,actorPersonId});
    return Response.json({ok:true,contractId:row.contract_id,state:row.state});
  }catch(error){return failure(error);}
}});
const document=defineTool({method:'GET',path:'/pot/:id/contracts/:offerId/document',auth:'loopback',async handler(req,ctx){
  try{
    const key={workspaceId:activeWorkspaceId(),daoSlug:ctx.params.id!};await resolveHiringActor(key);
    const row=await getContractExecution({...key,offerId:ctx.params.offerId!}),kind=new URL(req.url).searchParams.get('kind')??'sealed';
    if(!['source','sealed','certificate'].includes(kind))throw new ContractSigningError('invalid_input','Choose a contract PDF or audit certificate.');
    const bytes=kind==='source'?row.source_pdf:kind==='sealed'?row.sealed_pdf:row.audit_certificate;
    if(!bytes)throw new ContractSigningError('invalid_transition','The executed artifact is unavailable until both signers finish.');
    return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="contract-'+kind+'.pdf"','Cache-Control':'private, no-store'}});
  }catch(error){return failure(error);}
}});
const webhook=defineTool({method:'POST',path:'/dao-hr/documenso/webhook',auth:'public',async handler(req){
  try{
    const row=await completeContractSigning(req.headers.get('X-Documenso-Secret'),await req.json().catch(()=>null));
    return Response.json({ok:true,contractId:row.contract_id,state:row.state});
  }catch(error){return failure(error);}
}});
export default [get,post,document,webhook];
