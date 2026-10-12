import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { HiringView } from '@papercusp/operator-core/lib/dao-hr/hiring';

interface Template {templateKey:string;documentKind:string;engagementType:string;jurisdiction:string;title:string;latestVersion:number}
interface Execution {contractId:string;state:string;bindingEligible:boolean;documentHash:string|null;completedAt:string|null;signingLinks:Array<{email:string;signingUrl:string}>|null}
export default function ContractSigningViews({daoSlug,offer,people,onChanged}:{daoSlug:string;offer:HiringView['offers'][number];people:HiringView['people'];onChanged:()=>void}){
  const [templates,setTemplates]=useState<Template[]>([]),[execution,setExecution]=useState<Execution|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const url='/api/pot/'+encodeURIComponent(daoSlug)+'/contracts';
  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{const r=await fetch(url+'?offer='+encodeURIComponent(offer.offerId)),value=await r.json();if(!r.ok||!value.ok||!Array.isArray(value.templates)||!('execution' in value))throw new Error(value.message||'Contract records could not be read.');setTemplates(value.templates);setExecution(value.execution);}
    catch(cause){setTemplates([]);setExecution(null);setError(cause instanceof Error?cause.message:'Contract records could not be read.');}finally{setLoading(false);}
  },[url,offer.offerId]);
  useEffect(()=>{void load();},[load]);
  async function action(payload:unknown){
    setBusy(true);setError('');
    try{const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),value=await r.json();if(!r.ok||!value.ok)throw new Error(value.message||'The signing action was refused.');await load();onChanged();}
    catch(cause){setError(cause instanceof Error?cause.message:'The signing action was refused.');}finally{setBusy(false);}
  }
  async function prepare(event:FormEvent<HTMLFormElement>){event.preventDefault();const fields=new FormData(event.currentTarget);
    const refs=['engagement','equity'].map(name=>templates.find(t=>t.templateKey===fields.get(name))).filter((t):t is Template=>!!t).map(t=>({templateKey:t.templateKey,version:t.latestVersion}));
    await action({action:'prepare',offerId:offer.offerId,companyPersonId:fields.get('company'),startDate:fields.get('start'),templates:refs});
  }
  const available=templates.filter(t=>t.engagementType===offer.terms.engagementType&&t.jurisdiction===offer.terms.jurisdiction);
  const engagement=available.filter(t=>t.documentKind===(offer.terms.engagementType==='employee'?'employment-agreement':'contractor-agreement'));
  const equity=available.filter(t=>t.documentKind==='equity-grant-agreement');
  const pdfUrl=url+'/'+encodeURIComponent(offer.offerId)+'/document';
  return <section aria-label="Offer contract"><h4>Contract and signatures</h4>
    {error?<p role="alert">{error} <button type="button" onClick={()=>void load()}>Retry contract read</button></p>:null}
    {loading?<p role="status">Loading contract records…</p>:null}
    {execution?<>
      <p>Contract stage: {execution.state}</p>
      {!execution.bindingEligible?<p role="status">Non-binding sample. Counsel-approved templates and a formed issuing entity are required.</p>:execution.state!=='binding'?<p>Conditional contract: it takes effect only after the hire proposal executes.</p>:<p>Binding contract; hire proposal executed.</p>}
      <a className="dao-action" href={pdfUrl+'?kind=source'}>Download generated contract</a>
      {execution.state==='prepared'?<button type="button" className="dao-action" disabled={busy} onClick={()=>void action({action:'start',offerId:offer.offerId})}>Start signatures</button>:null}
      {execution.state==='dispatching'?<form className="dao-form" aria-label="Recover signing dispatch" onSubmit={event=>{event.preventDefault();const fields=new FormData(event.currentTarget);void action({action:'reconcile',offerId:offer.offerId,envelopeId:fields.get('envelope')});}}>
        <p>Find contract reference {execution.contractId} in Documenso and enter its envelope ID to recover signing.</p>
        <label>Documenso envelope ID<input name="envelope" required maxLength={200}/></label>
        <button type="submit" className="dao-action" disabled={busy||loading}>Recover signatures</button>
      </form>:null}
      {execution.signingLinks?.map(link=><p key={link.email}><a className="dao-action" href={link.signingUrl} target="_blank" rel="noopener noreferrer">Open authenticated signing for {link.email}</a></p>)}
      {execution.documentHash?<><p>Executed document hash: <code>{execution.documentHash}</code></p><p>Signatures completed: {execution.completedAt}</p>
        <a className="dao-action" href={pdfUrl+'?kind=sealed'}>Download sealed contract</a> <a className="dao-action" href={pdfUrl+'?kind=certificate'}>Download signing audit certificate</a></>:null}
      <button type="button" disabled={busy||loading} onClick={()=>void load()}>Refresh signature status</button>
    </>:offer.state==='approved'?engagement.length&&equity.length?<form className="dao-form" aria-label="Generate contract" onSubmit={prepare}>
      <p>Only registered templates matching this offer’s engagement and jurisdiction can be used.</p>
      <label>Engagement agreement<select className="dao-select" name="engagement" required>{engagement.map(t=><option key={t.templateKey} value={t.templateKey}>{t.title} · v{t.latestVersion}</option>)}</select></label>
      <label>Equity agreement<select className="dao-select" name="equity" required>{equity.map(t=><option key={t.templateKey} value={t.templateKey}>{t.title} · v{t.latestVersion}</option>)}</select></label>
      <label>Company countersigner<select className="dao-select" name="company" required><option value="">Select an HR admin</option>{people.filter(p=>p.personId!==offer.personId).map(p=><option key={p.personId} value={p.personId}>{p.displayName}</option>)}</select></label>
      <label>Start date<input name="start" type="date" required /></label>
      <button type="submit" className="dao-action" disabled={busy||loading}>Generate contract</button>
    </form>:<p>No registered engagement and equity templates match this offer. Add matching templates before generating the contract.</p>:<p>Internal approval is required before generating the contract.</p>}
  </section>;
}
