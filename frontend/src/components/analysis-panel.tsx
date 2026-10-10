'use client';
import {useState} from 'react';
import {useAiPanel} from '@/lib/use-ai-panel';
import type {AnalysisHistory,AiBoundary} from '@/lib/ai-panel-workflow';
import {submitAnalysisSchema} from '@leadpilot/backend/domain/analysis';
type Props=AiBoundary&{tenantId?:string;leadId:string;leadVersion:number};
export default function AnalysisPanel(props:Props){return <ScopedAnalysisPanel key={JSON.stringify([props.tenantId,props.leadId])} {...props}/>;}
function ScopedAnalysisPanel({tenantId,leadId,leadVersion,...boundary}:Props){
 const [notice,setNotice]=useState('');
 const {data,error,busy,pending:recovery,blocked,workflow}=useAiPanel<AnalysisHistory>('analyses',tenantId,leadId,leadVersion,boundary,()=>setNotice(''));
 async function mutate(path:string,version:number){setNotice('');await workflow.save(path,submitAnalysisSchema.parse({expected_version:version}),'POST',()=>setNotice('Request saved and history refreshed. The worker processes queued jobs.'));}
 if(!tenantId)return <div className="record-facts"><h3>AI analysis</h3><p>Connect Supabase and complete processing, model, language and scoring approvals to analyze real inquiries.</p><button disabled>Analyze inquiry</button></div>;
 const pending=data?.jobs.some(j=>['QUEUED','RUNNING'].includes(j.state));
 return <section className="analysis-panel"><h3>Evidence-backed analysis</h3><p>Review customer evidence and confirm facts before taking action. Analysis does not change lead status or send messages.</p>
  {error&&<p className="error" role="alert">{error}</p>}{notice&&<p className="success" role="status">{notice}</p>}
  {recovery&&<p role="status">{recovery==='write'?'Save result uncertain. Recover retries only the original request.':'Save acknowledged. Recover reloads history without saving again.'} Closing discards this in-memory recovery. <button disabled={busy} onClick={()=>void workflow.recover()}>Recover analysis request</button></p>}
  <div className="action-row"><button className="primary" disabled={blocked||!data?.enabled||pending} onClick={()=>void mutate(`/api/v1/leads/${leadId}/analyze`,data?.lead.version??leadVersion)}>Analyze inquiry</button><button disabled={busy||recovery==='write'} onClick={()=>{setNotice('');void workflow.refresh();}}>Refresh analysis</button></div>
  {!data&&<p>Load analysis history to check availability.</p>}{data&&!data.enabled&&<p>Analysis is unavailable until platform and agency approvals, model configuration and limits are complete, or this lead is reopened.</p>}
  {data&&data.jobs.length===0&&<p>No analysis yet. Missing facts remain unknown.</p>}
  {data?.jobs.map(job=>{const saved=data.analyses.find(a=>a.job_id===job.id),value=saved?.result,a=value?.analysis;return <article key={job.id} className="analysis-result"><div className="section-head"><strong>{job.state.replaceAll('_',' ')} {saved&&`· ${saved.freshness}`}</strong><small>{new Date(job.requested_at).toLocaleString()}</small></div>
   <p>Context {job.input_version} · {job.attempts}/3 attempts · Usage: {job.usage_state.toLowerCase()} {job.observed_tokens>0&&`· ${job.observed_tokens} observed tokens`}</p>
   {['QUEUED','RUNNING'].includes(job.state)&&<button disabled={blocked} onClick={()=>void mutate(`/api/v1/ai/jobs/${job.id}/cancel`,job.version)}>Cancel analysis</button>}
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
  {data?.next_cursor&&<button disabled={blocked} onClick={()=>void workflow.refresh(data.next_cursor!)}>Load older analyses</button>}
 </section>;
}
