'use client';
import {useEffect,useState} from 'react';
import {requestApi} from '@/lib/api-client';
import {usageWorkflow} from '@/lib/operations-workflow';
type Props={tenantId:string;version:number};
export default function AnalysisUsage(props:Props){return <ScopedUsage key={`${props.tenantId}:${props.version}`} {...props}/>;}
function ScopedUsage({tenantId}:Props){
 const [,render]=useState(0),[flow]=useState(()=>usageWorkflow(tenantId,requestApi,()=>render(n=>n+1)));
 useEffect(()=>{flow.activate();void flow.refresh();return()=>flow.close();},[flow]);
 const {data:usage,busy,error,loaded,denied}=flow.state;
 return <aside className="record-facts" aria-busy={busy}><h3>AI usage</h3>{error&&<p role="alert" className="error">{error}</p>}{busy&&<p role="status">Loading current usage…</p>}{!busy&&!loaded&&<p>Usage is unavailable. Limits and operation counts have not been verified.</p>}{usage&&<><p>Today: {usage.daily_operations} / {usage.daily_limit??'unconfigured'} operations · Month: {usage.monthly_operations} / {usage.monthly_limit??'unconfigured'}</p><p>{usage.reconciliation} operations need usage reconciliation. Queued, consumed and uncertain operations count toward limits; known unused operations release capacity. Windows reset in UTC.</p></>}<button type="button" disabled={busy||denied} onClick={()=>void flow.refresh()}>{busy?'Loading usage…':'Refresh usage'}</button></aside>;
}
