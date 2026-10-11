'use client';
import {useEffect,useRef,useState,type RefObject} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from './ui/dialog';
import {FactInputs,formFacts} from './lead-facts';
import {captureLeadSchema} from '@leadpilot/backend/domain/capture';
import {AddLeadWorkflow} from '@/lib/add-lead-workflow';
import {requestApi} from '@/lib/api-client';
type Props={tenantId?:string;role:string;trigger:RefObject<HTMLButtonElement|null>;onClose:()=>void;onCreated:(row:Record<string,unknown>)=>void};
export default function AddLeadDialog({tenantId,role,trigger,onClose,onCreated}:Props){
 const callbacks=useRef({onCreated,onClose});callbacks.current={onCreated,onClose};const flowRef=useRef<AddLeadWorkflow|null>(null);
 if(!flowRef.current)flowRef.current=new AddLeadWorkflow(tenantId??'',role,requestApi,s=>setState(s),row=>callbacks.current.onCreated(row));const flow=flowRef.current,[state,setState]=useState(flow.state),[inputError,setInputError]=useState('');
 useEffect(()=>{flow.activate();if(tenantId)void flow.directory();return()=>flow.close();},[flow,tenantId]);
 async function submit(form:FormData){if(flow.state.busy||flow.recovery.pending||state.denied)return;setInputError('');const input={full_name:form.get('name'),email:form.get('email'),phone:form.get('phone'),initial_message:form.get('message'),...formFacts(form),budget_min:form.get('budget_min')?Number(form.get('budget_min')):null,budget_max:form.get('budget_max')?Number(form.get('budget_max')):null,currency:form.get('currency')||null};
  if(tenantId){await flow.save({...input,...(role!=='AGENT'?{assignee_id:String(form.get('assignee_id')??'')||null}:{})});return;}
  const parsed=captureLeadSchema.safeParse(input);if(!parsed.success){setInputError(parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join(' '));return;}callbacks.current.onCreated({...parsed.data,id:crypto.randomUUID(),created_at:new Date().toISOString(),status:'NEW',source:'MANUAL',version:1,archived_at:null,assignee_id:null});
 }
 function close(){if(flow.state.busy)return;flow.close();callbacks.current.onClose();}
 const locked=!!tenantId&&(state.busy||!!state.pending||!state.ready),error=inputError||state.error;
 return <Dialog open onOpenChange={open=>{if(!open)close();}}><DialogContent closeDisabled={state.busy} aria-busy={state.busy} className="dialog" onCloseAutoFocus={e=>{e.preventDefault();trigger.current?.focus();}} onEscapeKeyDown={e=>{if(flow.state.busy)e.preventDefault();}} onInteractOutside={e=>e.preventDefault()}><DialogTitle className="text-xl pr-8">Add a lead</DialogTitle><DialogDescription>At least one valid contact is required. {tenantId?'Saved to your agency database.':'Saved in this preview session only.'}</DialogDescription>
 {state.denied?<p role="alert" className="error">Access is unavailable. Close this dialog and reopen your workspace before trying again.</p>:<><form onSubmit={e=>{e.preventDefault();void submit(new FormData(e.currentTarget));}} noValidate><fieldset disabled={locked} className="border-0 p-0 m-0 min-w-0"><label>Full name<input name="name" required minLength={2} maxLength={120} autoFocus/></label><label>Email<input name="email" type="email" maxLength={254}/></label><label>Phone<input name="phone" placeholder="+971501234567"/></label><label>Customer inquiry<textarea name="message" rows={4} maxLength={10000}/></label>{role!=='AGENT'&&<label>Assigned to<select name="assignee_id"><option value="">Manager queue</option>{state.members.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>}<details><summary>Optional confirmed requirements</summary><FactInputs includeBudget/></details><button className="primary" type="submit">{state.busy?'Please wait…':'Create lead'}</button></fieldset></form>
 {tenantId&&!state.ready&&!state.pending&&<p role="status">{state.busy?'Loading assignment choices…':'Assignment choices unavailable. Your inputs are retained.'} <button className="text-button" disabled={state.busy} onClick={()=>void flow.directory()}>Refresh assignment choices</button></p>}
 {state.pending&&<div role="status"><p>{state.pending==='write'?'The save result is unconfirmed. Recover using the original submitted data; do not create another attempt.':'Creation was acknowledged. Recover by reading the latest saved lead.'} Closing discards this retry; inspect saved records before submitting again.</p><button className="primary" disabled={state.busy} onClick={()=>void flow.recover()}>Recover lead save</button></div>}
 {error&&<p role="alert" className="error">{error}</p>}</>}
 </DialogContent></Dialog>;
}
