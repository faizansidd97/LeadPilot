'use client';
import {useEffect,useRef,useState} from 'react';
import {requestApi} from '@/lib/api-client';
type Usage={daily_limit:number|null;monthly_limit:number|null;daily_operations:number;monthly_operations:number;reconciliation:number};
export default function AnalysisUsage({tenantId,version}:{tenantId:string;version:number}){
 const [usage,setUsage]=useState<Usage|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),scope=useRef(0);
 async function load(){const current=scope.current;setBusy(true);try{const data=await requestApi('/api/v1/agency/ai-usage',{},tenantId);if(scope.current===current){setUsage(data);setError('');}}catch(e){if(scope.current===current)setError((e as Error).message);}finally{if(scope.current===current)setBusy(false);}}
 useEffect(()=>{scope.current++;setUsage(null);void load();return()=>{scope.current++;};},[tenantId,version]);
 return <aside className="record-facts"><h3>AI usage</h3>{error&&<p role="alert" className="error">{error}</p>}{usage&&<><p>Today: {usage.daily_operations} / {usage.daily_limit??'unconfigured'} operations · Month: {usage.monthly_operations} / {usage.monthly_limit??'unconfigured'}</p><p>{usage.reconciliation} operations need usage reconciliation. Queued, consumed and uncertain operations count toward limits; known unused operations release capacity. Windows reset in UTC.</p></>}<button type="button" disabled={busy} onClick={()=>void load()}>{busy?'Loading usage…':'Refresh usage'}</button></aside>;
}
