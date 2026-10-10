'use client';
import {useEffect,useRef,useState} from 'react';
import {ApiClientError,requestApi} from '@/lib/api-client';
import type {AnalysisResult} from '@leadpilot/backend/domain/analysis';
type Job={id:string;state:string;version:number;input_version:number;attempts:number;requested_at:string;failure_code:string|null;usage_state:string;observed_tokens:number};
type Result={id:string;job_id:string;freshness:string;model:string;input_version:number;created_at:string;result:AnalysisResult};
type History={enabled:boolean;lead:{version:number;context_version:number;current_analysis_id:string|null};jobs:Job[];analyses:Result[];next_cursor:string|null};
export default function AnalysisPanel({tenantId,leadId,leadVersion}:{tenantId?:string;leadId:string;leadVersion:number}){
 const [data,setData]=useState<History|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const scope=useRef(0),abort=useRef<AbortController|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),retry=useRef<{signature:string;key:string}|null>(null);
 const fetchPage=useRef<(cursor?:string)=>Promise<void>>(async()=>{});
 fetchPage.current=async(cursor?:string)=>{if(!tenantId)return;const current=scope.current;abort.current?.abort();abort.current=new AbortController();if(timer.current)clearTimeout(timer.current);
  try{const loaded:History=await requestApi(`/api/v1/leads/${leadId}/analyses`+(cursor?'?cursor='+encodeURIComponent(cursor):''),{signal:abort.current.signal},tenantId);if(current!==scope.current)return;setError('');
   setData(previous=>cursor&&previous?{...loaded,jobs:[...previous.jobs,...loaded.jobs],analyses:[...previous.analyses,...loaded.analyses]}:loaded);
   if(!cursor&&loaded.jobs.some(j=>['QUEUED','RUNNING'].includes(j.state)))timer.current=setTimeout(()=>{if(!document.hidden)void fetchPage.current();else timer.current=setTimeout(()=>void fetchPage.current(),30000);},30000);
  }catch(e){if(current!==scope.current||(e as Error).name==='AbortError')return;setError((e as Error).message);if(e instanceof ApiClientError&&[401,403,404].includes(e.status))setData(null);if(e instanceof ApiClientError&&e.status===429)timer.current=setTimeout(()=>void fetchPage.current(),Math.max(30,e.retryAfter??60)*1000);}
 };
 useEffect(()=>{scope.current++;setBusy(false);setData(null);setError('');setNotice('');retry.current=null;void fetchPage.current();return()=>{scope.current++;abort.current?.abort();if(timer.current)clearTimeout(timer.current);};},[tenantId,leadId,leadVersion]);
 async function mutate(path:string,version:number){if(!tenantId)return;const current=scope.current;setBusy(true);setError('');setNotice('');const payload=JSON.stringify({expected_version:version}),signature=path+payload;if(retry.current?.signature!==signature)retry.current={signature,key:crypto.randomUUID()};
  try{await requestApi(path,{method:'POST',body:payload},tenantId,retry.current.key);if(current!==scope.current)return;retry.current=null;setNotice('Request saved. The worker processes queued jobs.');await fetchPage.current();}
  catch(e){if(current===scope.current)setError((e as Error).message);}finally{if(current===scope.current)setBusy(false);}
 }
 if(!tenantId)return <div className="record-facts"><h3>AI analysis</h3><p>Connect Supabase and complete processing, model, language and scoring approvals to analyze real inquiries.</p><button disabled>Analyze inquiry</button></div>;
 const pending=data?.jobs.some(j=>['QUEUED','RUNNING'].includes(j.state));
 return <section className="analysis-panel"><h3>Evidence-backed analysis</h3><p>Review customer evidence and confirm facts before taking action. Analysis does not change lead status or send messages.</p>
  {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="success" role="status">{notice}</p>}
  <div className="action-row"><button className="primary" disabled={busy||!data?.enabled||pending} onClick={()=>void mutate(`/api/v1/leads/${leadId}/analyze`,data?.lead.version??leadVersion)}>Analyze inquiry</button><button disabled={busy} onClick={()=>void fetchPage.current()}>Refresh analysis</button></div>
  {!data&&<p>Load analysis history to check availability.</p>}{data&&!data.enabled&&<p>Analysis is unavailable until platform and agency approvals, model configuration and limits are complete, or this lead is reopened.</p>}
  {data&&data.jobs.length===0&&<p>No analysis yet. Missing facts remain unknown.</p>}
  {data?.jobs.map(job=>{const saved=data.analyses.find(a=>a.job_id===job.id),value=saved?.result,a=value?.analysis;return <article key={job.id} className="analysis-result"><div className="section-head"><strong>{job.state.replaceAll('_',' ')} {saved&&`· ${saved.freshness}`}</strong><small>{new Date(job.requested_at).toLocaleString()}</small></div>
   <p>Context {job.input_version} · {job.attempts}/3 attempts · Usage: {job.usage_state.toLowerCase()} {job.observed_tokens>0&&`· ${job.observed_tokens} observed tokens`}</p>
   {['QUEUED','RUNNING'].includes(job.state)&&<button disabled={busy} onClick={()=>void mutate(`/api/v1/ai/jobs/${job.id}/cancel`,job.version)}>Cancel analysis</button>}
   {job.failure_code&&<p role="status">{job.failure_code.replaceAll('_',' ')}. Refresh history before requesting another analysis.</p>}
   {saved?.freshness==='STALE'&&<p>This analysis uses earlier customer context. Request a new analysis for current facts.</p>}
   {a&&value&&<><p lang={a.language==='ar'?'ar':undefined} dir="auto">{a.summary||'No supported summary available.'}</p><p>Score: <strong>{value.score}/100 · {value.temperature}</strong> · Uncertainty: {a.uncertainty.toLowerCase()}</p><p>Rubric {value.rubric_version} · Model {saved.model}</p>
    <dl className="analysis-facts"><dt>Intent</dt><dd>{a.intent}</dd><dt>Budget</dt><dd>{a.budget.min??'Unknown'} – {a.budget.max??'Unknown'} {a.budget.currency??'currency unknown'} · {a.budget.period}</dd><dt>Areas</dt><dd>{a.needs.locations.join(', ')||'Unknown'}</dd><dt>Property</dt><dd>{a.needs.property_type??'Unknown'} · {a.needs.bedrooms??'Unknown'} bedrooms</dd><dt>Timeline</dt><dd>{a.needs.timeline??'Unknown'}</dd><dt>Requested next step</dt><dd>{a.next_step_requested}</dd></dl>
    <p>Score uses confirmed human facts first. Extracted facts shown above may differ.</p><p>{Object.entries(value.components).map(([field,points])=>`${field}: ${points}`).join(' · ')}</p>
    {a.flags.length>0&&<p>Review flags: {a.flags.map(f=>f.replaceAll('_',' ').toLowerCase()).join(', ')}</p>}
    {a.conflicts.length>0&&<p>Conflicting fields: {a.conflicts.map(c=>c.field).join(', ')}. Confirm these with the customer.</p>}
    <details><summary>Source evidence ({a.field_evidence.length})</summary>{a.field_evidence.map((e,i)=><blockquote key={i} dir="auto"><p>{e.excerpt}</p><small>{e.field} · Message {e.message_id} · version {e.message_version}</small></blockquote>)}</details>
    {a.questions.length>0&&<><h4>Suggested clarification questions</h4><ul>{a.questions.map((q,i)=><li key={i} dir="auto">{q}</li>)}</ul></>}
   </>}
  </article>;})}
  {data?.next_cursor&&<button disabled={busy} onClick={()=>void fetchPage.current(data.next_cursor!)}>Load older analyses</button>}
 </section>;
}
