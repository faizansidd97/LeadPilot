'use client';
import {useEffect,useRef,useState} from 'react';
import type {PrivacyCase} from '@leadpilot/backend/domain/privacy';
import type {PrivacyStatus} from '@leadpilot/backend/domain/privacy-execution';
import {requestApi} from '@/lib/api-client';
import {ClientRequests} from '@/lib/client-workflow';
import {PrivacySaveRecovery} from '@/lib/privacy-workflow';
import {readPrivacyExecution,beginPrivacyExecution} from '@/lib/privacy-execution';
import {loadPrivacyImpact} from '@/lib/privacy-impact';

type Props={tenantId:string;caseId:string;caseVersion:number;caseState:PrivacyCase['state'];owner:boolean;disabled:boolean;canStart:()=>boolean;onBusyChange:(busy:boolean)=>void};
export default function PrivacyExecutionPanel(props:Props){
 const [snapshot,setSnapshot]=useState<PrivacyStatus|null>(null),[subject,setSubject]=useState<number|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[pending,setPending]=useState<string|null>(null);
 const requests=useRef(new ClientRequests()),recovery=useRef(new PrivacySaveRecovery()),current=useRef(props);current.current=props;
 const publish=(data:PrivacyStatus)=>{setSnapshot(data);setConfirmed(false);};
 async function action(work:(ticket:ReturnType<ClientRequests['capture']>)=>Promise<unknown>){
  if(current.current.disabled||!current.current.canStart())return;const ticket=requests.current.beginAction();if(!ticket)return;setBusy(true);current.current.onBusyChange(true);setError('');
  try{await work(ticket);}catch(e){if(ticket.isCurrent()){setError(e instanceof Error?e.message:'Anonymization is unavailable. Refresh to retry.');setSnapshot(null);if([401,403,404].includes((e as {status?:number}).status??0)&&!recovery.current.pending)recovery.current.clear();}}
  finally{requests.current.finishAction(ticket);if(ticket.isCurrent()){setBusy(false);setPending(recovery.current.pending);current.current.onBusyChange(!!recovery.current.pending);}}
 }
 async function load(ticket:ReturnType<ClientRequests['capture']>){
  setSnapshot(null);setSubject(null);const data=await readPrivacyExecution(ticket,requestApi,props.tenantId,props.caseId);
  if(!data.job&&props.caseState==='IN_REVIEW'){
   const impact=await loadPrivacyImpact({tenantId:props.tenantId,caseId:props.caseId,caseVersion:props.caseVersion,caseState:props.caseState},ticket,requestApi);ticket.assertCurrent();setSubject(impact.subject_version);
  }
  ticket.assertCurrent();publish(data);
 }
 useEffect(()=>{requests.current.replace();void action(load);return()=>{requests.current.close();recovery.current.clear();current.current.onBusyChange(false);};},[]);
 return <section className="settings-section"><h3>Anonymization</h3>
  <p>Removes identifying content and blocks further work for this scope. Only summary counts remain for 30 days; after expiry, only minimal completion and protected restore records remain. This cannot be undone by restoring a lead.</p>
  <p>While a job is pending, agency actions may be temporarily unavailable. Closing an agency revokes its memberships and integrations; shared accounts keep their access to other agencies.</p>
  {error&&<p role="alert" className="error">{error}</p>}
  {pending?<button type="button" className="text-button" disabled={busy||props.disabled} onClick={()=>void action(ticket=>recovery.current.recover(ticket))}>{pending==='refresh'?'Load saved progress':'Recover original anonymization request'}</button>:<button type="button" className="text-button" disabled={busy||props.disabled} onClick={()=>void action(load)}>Refresh anonymization status</button>}
  {busy&&<p role="status">Checking anonymization…</p>}
  {!busy&&snapshot?.job&&<div role="status" className="invitation-receipt"><strong>{snapshot.job.state}</strong><p>{snapshot.job.processed} of {snapshot.job.total} records processed.</p>{snapshot.job.history_expires_at&&<p>Anonymous summary expires: {new Date(snapshot.job.history_expires_at).toLocaleString()}</p>}{snapshot.history&&<p>Summary: {snapshot.history.leads} leads, {snapshot.history.messages} messages, {snapshot.history.tasks} tasks.</p>}<p>Refresh to check current progress. Closure may remove your access; the operator retains completion evidence.</p></div>}
  {!busy&&snapshot&&!snapshot.job&&<>
   {!snapshot.policy_enabled&&<p>Execution is disabled until the operator enables the policy and independent restore-manifest storage.</p>}
   {props.owner&&props.caseState==='IN_REVIEW'&&snapshot.policy_enabled&&subject!==null&&!pending&&<form onSubmit={e=>{e.preventDefault();if(confirmed)void action(ticket=>beginPrivacyExecution(recovery.current,ticket,requestApi,props.tenantId,props.caseId,{expected_case_version:props.caseVersion,expected_subject_version:subject,expected_policy_version:snapshot.policy_version,confirm:'ANONYMIZE'},publish));}}>
    <label className="check-label"><input type="checkbox" required checked={confirmed} disabled={props.disabled} onChange={e=>setConfirmed(e.target.checked)}/>I have reviewed this scope, identity verification and external copies, and understand the content will be removed.</label>
    <button className="primary" type="submit" disabled={!confirmed||props.disabled}>Prepare anonymization</button>
   </form>}
   {props.caseState!=='IN_REVIEW'&&<p>Record identity verification and resolve holds before preparing anonymization.</p>}
  </>}
 </section>;
}
