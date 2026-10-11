"use client";
import {useEffect,useRef,useState} from 'react';
import {requestApi} from '@/lib/api-client';
import {formatAgencyDate,taskStates,type FollowUp,type TaskState} from '@leadpilot/backend/domain/workflows';
import {FollowUpQueue} from '@/lib/follow-up-workflow';
import type {Lead} from './workspace';
type Props={tenantId?:string;timezone:string;role:string;tasks:FollowUp[];leads:Lead[];onOpen:(row:Record<string,unknown>)=>void;onPreviewOpen:(id:string)=>void;revision:number};
export default function FollowUpInbox(props:Props){return <ScopedFollowUpInbox key={JSON.stringify([props.tenantId??'preview',props.role,props.timezone])} {...props}/>;}
function ScopedFollowUpInbox({tenantId,timezone,tasks,leads,onOpen,onPreviewOpen,revision}:Props){
 const callbacks=useRef(onOpen);callbacks.current=onOpen;
 const queueRef=useRef<FollowUpQueue|null>(null);if(!queueRef.current)queueRef.current=new FollowUpQueue(tenantId??'',requestApi,{change:state=>setState(state),open:row=>callbacks.current(row)});
 const queue=queueRef.current,[state,setState]=useState(queue.state),[previewFilter,setPreviewFilter]=useState<TaskState>('OPEN');
 useEffect(()=>{if(!tenantId)return;queue.activate();void queue.refresh();return()=>queue.close();},[queue,tenantId,revision]);
 const filter=tenantId?state.filter:previewFilter,busy=!!tenantId&&state.busy,ready=!tenantId||state.ready;
 const visible=tenantId?state.rows:tasks.filter(task=>task.state===filter).slice().sort((a,b)=>Date.parse(a.due_at)-Date.parse(b.due_at)||a.id.localeCompare(b.id));
 return <section className="panel" aria-busy={busy}><div className="section-head"><div><h2>Follow-up queue</h2><p>Open a lead to complete, reschedule or cancel a task. Times use {timezone}.</p></div><div className="flex items-center gap-3"><select aria-label="Task state" value={filter} disabled={busy} onChange={e=>tenantId?void queue.filter(e.target.value as TaskState):setPreviewFilter(e.target.value as TaskState)}>{taskStates.map(value=><option key={value}>{value}</option>)}</select>{tenantId&&<button className="text-button" disabled={busy} onClick={()=>void queue.refresh()}>Refresh queue</button>}</div></div>
 {tenantId&&state.error&&<p className="error p-4" role="alert">{state.error} Refresh the queue to retry.</p>}
 {tenantId&&!ready&&state.loaded&&<p className="p-4" role="status">Queue unavailable. Task previews are hidden until refresh confirms current access.</p>}
 <div className="table-wrap"><table><thead><tr><th>Task</th><th>Lead</th><th>Due time</th><th>Ownership</th><th>State</th></tr></thead><tbody>{visible.map(task=><tr key={task.id}><td><button className="lead-name" disabled={busy||!ready} onClick={()=>tenantId?void queue.open(task as typeof state.rows[number]):onPreviewOpen(task.lead_id)}><strong>{ready?task.title:'Task preview unavailable'}</strong></button>{ready&&<small>{task.type}</small>}</td><td>{ready?(task.leads?.full_name??leads.find(lead=>lead.id===task.lead_id)?.name??'Lead'):'Unavailable'}</td><td>{ready?formatAgencyDate(task.due_at,timezone):'Unavailable'}</td><td>{ready?(task.assignee_id?'Assigned member':'Manager queue'):'Unavailable'}</td><td>{ready?<span className={`chip ${task.state==='OPEN'&&Date.parse(task.due_at)<=Date.now()?'overdue':''}`}>{task.state==='OPEN'&&Date.parse(task.due_at)<=Date.now()?'OVERDUE':task.state}</span>:'Unavailable'}</td></tr>)}</tbody></table>
 {!visible.length&&<p className="empty" role="status">{busy?'Loading tasks…':!ready?'Follow ups unavailable. Refresh to load the queue.':'No '+filter.toLowerCase()+' follow ups.'+(filter==='OPEN'?' Schedule a task from a lead.':'')}</p>}</div>
 {tenantId&&state.cursor&&<div className="section-head"><button className="text-button" disabled={busy||!ready} onClick={()=>void queue.refresh(true)}>Load more tasks</button></div>}
 </section>;
}
