'use client';
import {useEffect,useRef,useState} from 'react';
import {Bell,ArrowUpRight,Check,Archive} from 'lucide-react';
import {requestApi} from '@/lib/api-client';
import {NotificationWorkflow,type NotificationState} from '@/lib/notification-workflow';
import {notificationLabels,type NotificationFilter} from '@leadpilot/backend/domain/notifications';
import {formatAgencyDate} from '@leadpilot/backend/domain/workflows';
type Props={tenantId?:string;timezone:string;onLead:(row:Record<string,unknown>)=>void;onTeam:()=>void;onCount:(count:number|null)=>void};
export default function NotificationsInbox(props:Props){return <ScopedNotificationsInbox key={props.tenantId??'preview'} {...props}/>;}
function ScopedNotificationsInbox({tenantId,timezone,onLead,onTeam,onCount}:Props){
 const callbacks=useRef({onLead,onTeam,onCount});callbacks.current={onLead,onTeam,onCount};
 const [state,setState]=useState<NotificationState>({rows:[],cursor:null,filter:'ALL',busy:false,ready:false,loaded:false,pending:null,error:'',notice:''});
 const client=useRef<NotificationWorkflow|null>(null);
 if(!client.current)client.current=new NotificationWorkflow(tenantId??'',requestApi,{change:setState,count:count=>callbacks.current.onCount(count),open:target=>{if(target.kind==='lead')callbacks.current.onLead(target.row);else callbacks.current.onTeam();}});
 const workflow=client.current,{rows,cursor,filter,busy,ready,pending,error,notice}=state;
 const blocked=busy||!!pending||!ready;
 useEffect(()=>{workflow.activate();if(tenantId)void workflow.refresh();return()=>workflow.close();},[workflow,tenantId]);
 useEffect(()=>{if(!tenantId||busy||pending||!ready)return;const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!workflow.state.busy&&!workflow.recovery.pending)void workflow.refresh();},45000);return()=>clearInterval(timer);},[workflow,tenantId,busy,pending,ready,filter]);
 if(!tenantId)return <section className="panel empty notification-preview"><Bell size={35}/><h2>Your next actions, in one place.</h2><p>Connected accounts receive lead assignments, due follow ups and team notices here.</p><p>Connect Supabase and configure the protected scheduler to receive automatic reminders. Preview does not run background jobs or send messages.</p></section>;
 return <section className="panel" aria-busy={busy}>
  <div className="section-head"><div><h2>Your notifications</h2><p>Only notices addressed to you. The latest record is checked before opening.</p></div><div className="notification-tools"><select aria-label="Notification filter" value={filter} disabled={busy||!!pending} onChange={e=>void workflow.filter(e.target.value as NotificationFilter)}><option value="ALL">Inbox</option><option value="UNREAD">Unread</option><option value="DISMISSED">Dismissed</option></select><button className="text-button" disabled={busy||pending==='write'} onClick={()=>void workflow.refresh()}>{busy?'Working…':'Refresh'}</button></div></div>
  {error&&<p role="alert" className="error notification-feedback">{error}</p>}{notice&&<p role="status" className="notification-feedback">{notice}</p>}
  {pending&&<p role="status" className="notification-feedback">{pending==='write'?'Save result uncertain. Recover retries only your original read/dismiss request.':'Save acknowledged. Recover reloads notifications without saving again.'} Leaving this inbox discards its in-memory recovery. <button disabled={busy} className="text-button" onClick={()=>void workflow.recover()}>Recover notification action</button></p>}
  {!ready&&rows.length>0&&<p role="status" className="notification-feedback">Refresh or recover to check the latest inbox. Sensitive previews are hidden while it is unavailable.</p>}
  <div className="notification-list">{rows.map(row=>{const current=ready&&row.current;return <article key={row.id} className={row.read_at?'':'notification-unread'}><span className="notification-symbol"><Bell size={19}/></span><div className="notification-copy"><div><h3>{!ready?'Refresh to check this notice':current?notificationLabels[row.type]:row.can_open?'This notice is outdated':'This record is unavailable'}</h3>{!row.read_at&&<span className="chip">Unread</span>}</div>{current&&row.resource_label&&<p>{row.resource_label}</p>}{current&&row.due_at&&<p>Due {formatAgencyDate(row.due_at,timezone)}</p>}{ready&&!row.current&&<p>{row.can_open?'Open to see the latest authorized state.':'Access or resource state changed. Sensitive previews are hidden.'}</p>}<small>{formatAgencyDate(row.created_at,timezone)}</small><div className="notification-actions">{row.can_open&&<button className="text-button" disabled={blocked} onClick={()=>void workflow.open(row)}><ArrowUpRight size={15}/>Open latest</button>}{!row.read_at&&<button className="text-button" disabled={blocked} onClick={()=>void workflow.change(row,'read')}><Check size={15}/>Mark read</button>}{!row.dismissed_at&&<button className="text-button" disabled={blocked} onClick={()=>void workflow.change(row,'dismiss')}><Archive size={15}/>Dismiss</button>}</div></div></article>;})}</div>
  {!rows.length&&<div className="empty"><Bell size={28}/><h2>{busy?'Loading notifications…':!ready?'Notifications unavailable':filter==='UNREAD'?'You’re caught up':filter==='DISMISSED'?'No dismissed notifications':'No notifications yet'}</h2><p>{busy?'':!ready?'Refresh to load your latest inbox.':'Assignments and due follow ups appear here. Check with your agency owner if reminders are delayed.'}</p></div>}
  {cursor&&<div className="section-head"><button className="text-button" disabled={blocked} onClick={()=>void workflow.refresh(true)}>Load more notifications</button></div>}
 </section>;
}
