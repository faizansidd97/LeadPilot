'use client';
import {useEffect,useRef,useState} from 'react';
import {requestApi} from '@/lib/api-client';
import {operationsAlertLabels,type OperationsSnapshot} from '@leadpilot/backend/domain/operations';
import AnalysisUsage from './analysis-usage';
const age=(seconds:number)=>seconds<60?`${seconds}s`:seconds<3600?`${Math.floor(seconds/60)}m`:`${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m`;
export default function OperationsPanel({tenantId,owner,agencyVersion}:{tenantId:string;owner:boolean;agencyVersion:number}){
 const [snapshot,setSnapshot]=useState<{tenant:string;data:OperationsSnapshot}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const generation=useRef(0),controller=useRef<AbortController|null>(null),refresh=useRef<()=>void>(()=>{});
 useEffect(()=>{
  const current=++generation.current;setSnapshot(null);setError('');let loading=false;
  const load=async()=>{if(loading)return;loading=true;setBusy(true);const abort=new AbortController();controller.current=abort;
   try{const data:OperationsSnapshot=await requestApi('/api/v1/agency/operations',{signal:abort.signal},tenantId);if(current===generation.current){setSnapshot({tenant:tenantId,data});setError('');}}
   catch(e){if(current===generation.current&&!abort.signal.aborted){setSnapshot(null);setError((e as Error).message);}}
   finally{loading=false;if(current===generation.current)setBusy(false);}
  };
  refresh.current=()=>void load();void load();
  const visible=()=>{if(document.visibilityState==='visible')void load();};const timer=window.setInterval(visible,60000);document.addEventListener('visibilitychange',visible);
  return()=>{generation.current++;controller.current?.abort();window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[tenantId]);
 const data=snapshot?.tenant===tenantId?snapshot.data:null;
 return <section className="settings-section" aria-label="Agency operations" aria-busy={busy}>
  <div className="section-head"><div><h2>Operations status</h2><p>Agency queue snapshot. Updates every minute while this tab is visible.</p></div><button type="button" disabled={busy} onClick={()=>refresh.current()}>{busy?'Refreshing…':'Refresh status'}</button></div>
  {error&&<p className="error" role="alert">{error}</p>}{busy&&!data&&<p role="status">Loading operations status…</p>}
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
  {owner&&data&&<AnalysisUsage key={tenantId} tenantId={tenantId} version={agencyVersion}/>}<p>Global monitoring and incident handling remain with your operations team.</p>
 </section>;
}
