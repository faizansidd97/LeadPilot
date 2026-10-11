'use client';
import {useEffect,useState} from 'react';
import {requestApi} from '@/lib/api-client';
import {operationsAlertLabels} from '@leadpilot/backend/domain/operations';
import AnalysisUsage from './analysis-usage';
import {operationsWorkflow} from '@/lib/operations-workflow';
const age=(seconds:number)=>seconds<60?`${seconds}s`:seconds<3600?`${Math.floor(seconds/60)}m`:`${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m`;
type Props={tenantId:string;owner:boolean;agencyVersion:number};
export default function OperationsPanel(props:Props){return <ScopedOperations key={`${props.tenantId}:${props.owner}:${props.agencyVersion}`} {...props}/>;}
function ScopedOperations({tenantId,owner,agencyVersion}:Props){
 const [,render]=useState(0),[flow]=useState(()=>operationsWorkflow(tenantId,requestApi,()=>render(n=>n+1)));
 useEffect(()=>{
  flow.activate();void flow.refresh();
  const visible=()=>{if(document.visibilityState==='visible')void flow.refresh();};
  const timer=window.setInterval(visible,60000);document.addEventListener('visibilitychange',visible);
  return()=>{flow.close();window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[flow]);
 const {data,busy,error,loaded,denied}=flow.state;
 return <section className="settings-section" aria-label="Agency operations" aria-busy={busy}>
  <div className="section-head"><div><h2>Operations status</h2><p>Agency queue snapshot. Updates every minute while this tab is visible.</p></div><button type="button" disabled={busy||denied} onClick={()=>void flow.refresh()}>{busy?'Refreshing…':'Refresh status'}</button></div>
  {error&&<p className="error" role="alert">{error}</p>}{busy&&!data&&<p role="status">Loading operations status…</p>}{!busy&&!loaded&&<p>Operations status is unavailable. Queue counts and alerts have not been verified.</p>}
  {data&&<>
   <p>Captured {new Date(data.captured_at).toLocaleString()}.</p>
   <aside className="record-facts" aria-label="Queue alerts">{data.alerts.length?<><h3>Needs attention</h3><ul>{data.alerts.map(code=><li key={code}>{operationsAlertLabels[code]}</li>)}</ul><p>Contact your operations team to review failures, scheduler configuration and uncertain AI usage.</p></>:<><h3>No queue alerts in this snapshot</h3><p>Live scheduler execution and delivery still need operational verification.</p></>}</aside>
   <div className="settings-cards">
    <article><h3>Due reminders</h3><p><strong>{data.reminders.awaiting_creation}</strong> reminder deliveries await creation.</p><p>Oldest due: {age(data.reminders.oldest_due_seconds)}</p><small>Counts each eligible recipient and task schedule.</small></article>
    <article><h3>Notifications & invitations</h3><p>{data.notifications.pending} pending · {data.notifications.running} running</p><p>{data.notifications.failed} retained failures · {data.notifications.expired_leases} expired leases</p><p>Oldest pending: {age(data.notifications.oldest_pending_seconds)}</p><small>Transport acceptance is recorded separately from delivered email.</small></article>
    <article><h3>AI analysis & drafts</h3><p>{data.ai.queued} queued · {data.ai.running} running</p><p>{data.ai.failed} retained failures · {data.ai.expired_leases} expired leases</p><p>Oldest pending: {age(data.ai.oldest_pending_seconds)}</p><p>{data.ai.reconciliation} operations need usage reconciliation.</p></article>
   </div>
   <p>Delay alerts start after 15 minutes. Failed jobs remain counted until recovered; this view does not retry jobs or change reservations. Provider cost has not been reconciled.</p>
  </>}
  {owner&&data&&<AnalysisUsage key={`${tenantId}:${agencyVersion}`}  tenantId={tenantId} version={agencyVersion}/>}<p>Global monitoring and incident handling remain with your operations team.</p>
 </section>;
}
