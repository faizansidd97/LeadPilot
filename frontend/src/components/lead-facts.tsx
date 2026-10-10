'use client';
import {useEffect,useRef,useState} from 'react';
import type {Lead} from './workspace';
import {factsSchema,duplicateSchema} from '@leadpilot/backend/domain/capture';
import {requestApi,toLead} from '@/lib/api-client';
import {ClientRequests,type RequestTicket} from '@/lib/client-workflow';
import {LeadSaveRecovery} from '@/lib/lead-workflow';
import {beginFactsSave,loadFactsLead,loadDuplicatePage,type DuplicateCandidate} from '@/lib/facts-workflow';
export function formFacts(form:FormData){const text=(key:string)=>String(form.get(key)??'');return {confirmed_intent:text('confirmed_intent')||null,budget_period:text('budget_period')||'UNKNOWN',locations:text('locations').split('|').map(v=>v.trim()).filter(Boolean),property_type:text('property_type')||null,bedrooms:text('bedrooms')===''?null:Number(text('bedrooms')),purchase_timeline:text('purchase_timeline')||null,source_reference:text('source_reference')||null,notes:text('notes')};}
export function FactInputs({lead,includeBudget=false}:{lead?:Lead;includeBudget?:boolean}){return <>
 <div className="form-grid"><label>Confirmed intent<select name="confirmed_intent" defaultValue={lead?.confirmed_intent??''}><option value="">Unknown</option>{['BUY','RENT','SELL','INVEST','OTHER'].map(v=><option key={v}>{v}</option>)}</select></label><label>Budget period<select name="budget_period" defaultValue={lead?.budget_period??'UNKNOWN'}>{['UNKNOWN','MONTH','YEAR','TOTAL'].map(v=><option key={v}>{v}</option>)}</select></label></div>
 {includeBudget&&<div className="form-grid"><label>Budget minimum<input type="number" step="any" min={0} name="budget_min"/></label><label>Budget maximum<input type="number" step="any" min={0} name="budget_max"/></label><label>Currency<select name="currency"><option value="">Unknown</option>{['AED','USD','EUR','GBP','SAR'].map(v=><option key={v}>{v}</option>)}</select></label></div>}
 <label>Locations · separate with |<input name="locations" maxLength={604} defaultValue={lead?.locations?.join(' | ')??''} placeholder="Dubai Marina | JVC"/></label><div className="form-grid"><label>Property type<input name="property_type" maxLength={120} defaultValue={lead?.property_type??''}/></label><label>Bedrooms · 0 means confirmed studio<input name="bedrooms" type="number" min={0} max={50} step={1} defaultValue={lead?.bedrooms??''}/></label></div>
 <label>Purchase / rental timeline<input name="purchase_timeline" maxLength={500} defaultValue={lead?.purchase_timeline??''}/></label><label>Source reference<input name="source_reference" readOnly={lead?.source==='WEBSITE'} maxLength={500} defaultValue={lead?.source_reference??''}/></label><label>Internal notes<textarea name="notes" rows={3} maxLength={2000} defaultValue={lead?.notes??''}/></label>
 </>;}
type Props={lead:Lead;tenantId?:string;userRole:'OWNER'|'ADMIN'|'AGENT';onLead:(lead:Lead)=>void;disabled?:boolean;canStart?:()=>boolean;onStateChange?:(state:{busy:boolean;pending:boolean})=>void;onAccessDenied?:(error:unknown)=>void};
export default function LeadFacts(props:Props){return <ScopedFacts key={JSON.stringify([props.lead.id,props.tenantId,props.userRole])} {...props}/>;}
function ScopedFacts({lead,tenantId,userRole,onLead,disabled=false,...callbacks}:Props){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[candidates,setCandidates]=useState<DuplicateCandidate[]>([]),[reviewLoaded,setReviewLoaded]=useState(false),[cursor,setCursor]=useState<string|null>(null);
 const [reviewUnavailable,setReviewUnavailable]=useState(false),[needsRefresh,setNeedsRefresh]=useState(false),[accessLost,setAccessLost]=useState(false),[formVersion,setFormVersion]=useState(0);
 const requests=useRef(new ClientRequests()),recovery=useRef(new LeadSaveRecovery()),locked=useRef(false),reviewForm=useRef<HTMLFormElement>(null),options=useRef({disabled,...callbacks});options.current={disabled,...callbacks};
 function working(value:boolean){locked.current=value;setBusy(value);options.current.onStateChange?.({busy:value,pending:!!recovery.current.pending});}
 useEffect(()=>{requests.current.replace();return()=>{requests.current.close();recovery.current.clear();options.current.onStateChange?.({busy:false,pending:false});};},[]);
 function fail(e:unknown,ticket:RequestTicket){
  if(!ticket.isCurrent())return;
  const status=(e as {status?:number})?.status;
  if([401,403,404].includes(status??0)){recovery.current.clear();setCandidates([]);setCursor(null);setReviewLoaded(false);setAccessLost(true);setNotice('');options.current.onAccessDenied?.(e);}
  if(status===409)setNeedsRefresh(true);
  setError(e instanceof Error?e.message:'The operation could not complete. Retry the original action.');
 }
 function begin(allowPending=false){if(options.current.disabled||options.current.canStart?.()===false||accessLost||locked.current||!allowPending&&recovery.current.pending)return null;const ticket=requests.current.beginAction();if(ticket){working(true);setError('');setNotice('');}return ticket;}
 function finish(ticket:RequestTicket){requests.current.finishAction(ticket);if(ticket.isCurrent())working(false);}
 async function refresh(){const ticket=begin(true);if(!ticket)return;try{
  if(recovery.current.pending)await recovery.current.recover(ticket);
  else if(tenantId){const row=await loadFactsLead(ticket,requestApi,tenantId,lead.id);ticket.assertCurrent();onLead({...toLead(row),message:lead.message});setNeedsRefresh(false);setNotice('Latest facts loaded. Your entered values are retained; review them before saving.');}
 }catch(e){fail(e,ticket);}finally{finish(ticket);}}
 async function save(kind:'facts'|'duplicates',input:unknown){
  if(needsRefresh||lead.archived_at||kind==='duplicates'&&(userRole==='AGENT'||!reviewLoaded||reviewUnavailable))return;
  const ticket=begin();if(!ticket)return;
  const complete=()=>{setNeedsRefresh(false);if(kind==='facts')setFormVersion(current=>current+1);else{reviewForm.current?.reset();setCandidates([]);setCursor(null);setReviewLoaded(false);}setNotice('Saved.');};
  try{if(tenantId)await beginFactsSave(recovery.current,ticket,requestApi,tenantId,lead.id,{kind,input},row=>{ticket.assertCurrent();onLead({...toLead(row),message:lead.message});},complete);
   else{const {expected_version,...facts}=factsSchema.parse(input);ticket.assertCurrent();onLead({...lead,...facts,area:facts.locations?.join(', ')||lead.area,version:(lead.version??1)+1});complete();}
  }catch(e){fail(e,ticket);}finally{finish(ticket);}
 }
 async function review(more=false){if(!tenantId||userRole==='AGENT'||needsRefresh||more&&!cursor)return;const ticket=begin();if(!ticket)return;try{
  const page=await loadDuplicatePage(ticket,requestApi,tenantId,lead.id,userRole,more?cursor:null);ticket.assertCurrent();
  setCandidates(current=>more?[...current,...page.candidates]:page.candidates);setCursor(page.next_cursor);setReviewLoaded(true);setReviewUnavailable(false);
  if(!page.review_required){setNeedsRefresh(true);setNotice('Duplicate review changed. Load the latest lead before continuing.');}
 }catch(e){if(ticket.isCurrent())setReviewUnavailable(true);fail(e,ticket);}finally{finish(ticket);}}
 const pending=recovery.current.pending;
 if(accessLost)return <p className="error" role="alert">{error||'This lead is unavailable. Reopen your workspace.'}</p>;
 return <><p>Save facts explicitly confirmed by a person. Empty values remain unknown. Budget amounts are edited under Overview.</p>{lead.source==='WEBSITE'&&Object.keys(lead.reported_facts??{}).length>0&&<div className="task-warning"><strong>Website reported requirements · awaiting human confirmation</strong><dl>{Object.entries(lead.reported_facts??{}).map(([key,value])=><div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{value==null?'Unknown':Array.isArray(value)?value.join(', '):String(value)}</dd></div>)}</dl></div>}
 {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="success" role="status">{notice}</p>}
 {pending&&<div className="task-warning" role="status"><p>{pending==='write'?'The save result is uncertain. Recover the original save before making another change.':'Your save was received. Load the saved facts to finish.'} Closing this lead discards the retry details kept on this page.</p><button type="button" className="primary" disabled={busy||disabled} onClick={()=>void refresh()}>{pending==='write'?'Recover original save':'Load saved facts'}</button></div>}
 {needsRefresh&&!pending&&<div className="task-warning"><p>Your entered values are retained. Load the latest lead before saving again.</p><button type="button" className="primary" disabled={busy||disabled} onClick={()=>void refresh()}>Load latest facts</button></div>}
 {!accessLost&&<><form key={formVersion} onSubmit={e=>{e.preventDefault();try{void save('facts',factsSchema.parse({...formFacts(new FormData(e.currentTarget)),expected_version:lead.version??1}));}catch(e){setError((e as Error).message);}}}><fieldset disabled={disabled||busy||!!pending||needsRefresh||!!lead.archived_at}><FactInputs lead={lead}/><div className="task-actions"><button className="primary">Save confirmed facts</button><button type="button" className="text-button" onClick={()=>{if(!locked.current&&!recovery.current.pending&&!options.current.disabled&&options.current.canStart?.()!==false)setFormVersion(current=>current+1);}}>Reset to saved facts</button></div></fieldset></form>
 {lead.duplicate_review&&<section className="settings-section"><h3>Duplicate review required</h3>{userRole==='AGENT'?<p>A manager will review matching contacts. Other lead identities are restricted.</p>:<><p>Review matching contacts before keeping these records separate. Records are never merged automatically.</p>{tenantId&&<button type="button" className="text-button" disabled={disabled||busy||!!pending||needsRefresh} onClick={()=>void review()}>Review matching leads</button>}{!tenantId&&<p>Candidate matching requires the connected agency database.</p>}{busy&&!pending&&<p role="status">Checking the requested action…</p>}{reviewUnavailable&&<p role="status">Matching leads could not be refreshed. Retry review before resolving duplicates.</p>}{reviewLoaded&&<><ul>{candidates.map(c=><li key={c.id}><strong>{c.full_name}</strong> · {c.email||c.phone} · {c.status}{c.archived_at?' · Archived':''}</li>)}</ul>{!candidates.length&&!reviewUnavailable&&<p>No current matching contacts.</p>}{cursor&&<button type="button" className="text-button" disabled={disabled||busy||!!pending||needsRefresh} onClick={()=>void review(true)}>More matches</button>}<form ref={reviewForm} onSubmit={e=>{e.preventDefault();try{void save('duplicates',duplicateSchema.parse({expected_version:lead.version??1,reason:new FormData(e.currentTarget).get('reason')}));}catch(e){setError((e as Error).message);}}}><fieldset disabled={disabled||busy||!!pending||needsRefresh||reviewUnavailable||!!lead.archived_at}><label>Reason for keeping this lead separate<textarea name="reason" minLength={5} maxLength={500} required/></label><button className="primary">Resolve as separate records</button></fieldset></form></>}</>}</section>}</>}
 </>;
}
