'use client';
import {useEffect,useRef,useState} from 'react';
import type {PrivacyImpact} from '@leadpilot/backend/domain/privacy';
import {ClientRequests} from '@/lib/client-workflow';
import {loadPrivacyImpact} from '@/lib/privacy-impact';
import {requestApi} from '@/lib/api-client';
const labels:Record<keyof PrivacyImpact['counts'],string>={leads:'Leads',messages:'Conversation messages',message_revisions:'Message revisions',
 follow_ups:'Follow ups',activity_events:'Activity evidence',ai_jobs:'AI jobs',ai_analyses:'AI analyses',reply_drafts:'Reply drafts',
 draft_feedback:'Draft feedback',notifications:'Notifications',privacy_cases:'Related privacy cases',privacy_case_actions:'Review notes'};
export default function PrivacyImpactPanel({tenantId,caseId,caseVersion,caseState}:{tenantId:string;caseId:string;caseVersion:number;caseState:PrivacyImpact['case_state']}){
 const scope=useRef(new ClientRequests()),[data,setData]=useState<PrivacyImpact|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function load(){
  const ticket=scope.current.beginAction();if(!ticket)return;
  setData(null);setError('');setBusy(true);
  try{const result=await loadPrivacyImpact({tenantId,caseId,caseVersion,caseState},ticket,requestApi);if(ticket.isCurrent())setData(result);}
  catch(e){if(ticket.isCurrent())setError(e instanceof Error?e.message:'The impact preview could not load.');}
  finally{if(ticket.isCurrent())setBusy(false);scope.current.finishAction(ticket);}
 }
 useEffect(()=>{scope.current.replace();void load();return()=>scope.current.close();},[tenantId,caseId,caseVersion,caseState]);
 return <section className="settings-section" aria-labelledby="privacy-impact-heading">
  <div className="section-head"><div><h3 id="privacy-impact-heading">Request impact preview</h3><p>Related records for this {data?.kind==='AGENCY_CLOSURE'?'agency':'request'}.</p></div>
   <button type="button" className="text-button" disabled={busy} onClick={()=>void load()}>Refresh preview</button></div>
  {busy&&<p role="status">Checking related records…</p>}
  {error&&<p role="alert" className="error">{error}</p>}
  {data&&<><p>Snapshot: {new Date(data.as_of).toLocaleString()} · case version {data.case_version}</p>
   <div className="form-grid"><div><strong>Identity verification</strong><p>{data.identity_verification_recorded?'Reference recorded':'Not yet recorded'}</p></div>
    <div><strong>Review holds</strong><p>{data.intersecting_holds} affecting this scope</p></div>
    <div><strong>Open follow ups</strong><p>{data.open_tasks}</p></div>
    <div><strong>AI work</strong><p>{data.active_ai_jobs} active · {data.reconcile_ai_jobs} awaiting usage reconciliation</p></div></div>
   {(data.intersecting_holds>0||data.case_state==='WITHDRAWN')&&<p className="invitation-receipt" role="status">{data.case_state==='WITHDRAWN'?'This request has been withdrawn.':'A review hold affects this request. Resolve its basis before proceeding with a deletion plan.'}</p>}
   <div className="table-wrap"><table><caption>Related workspace records</caption><thead><tr><th scope="col">Record type</th><th scope="col">Count</th></tr></thead>
    <tbody>{Object.entries(labels).map(([key,label])=><tr key={key}><th scope="row">{label}</th><td>{data.counts[key as keyof typeof labels].toLocaleString()}</td></tr>)}</tbody></table></div>
   <p>These counts help review the request. They do not decide which records should be deleted or retained. Background records, provider copies and backups need a separate reviewed plan.</p>
   <p className="invitation-receipt"><strong>Deletion approval pending.</strong> Retention rules and deletion execution are still being prepared. Normal workspace operations can change these counts; refresh before reviewing them.</p>
  </>}
 </section>;
}
