'use client';
import {useEffect,useRef,useState} from 'react';
import {requestApi} from './api-client';
import {AiPanelWorkflow,type AiHistory,type AiState,type AiBoundary} from './ai-panel-workflow';

export function useAiPanel<T extends AiHistory>(kind:'analyses'|'drafts',tenantId:string|undefined,leadId:string,leadVersion:number,boundary:AiBoundary,clearPrivate:()=>void){
 const callbacks=useRef({boundary,clearPrivate});callbacks.current={boundary,clearPrivate};
 const [state,setState]=useState<AiState<T>>({data:null,busy:false,ready:false,pending:null,error:''});
 const client=useRef<AiPanelWorkflow<T>|null>(null);
 if(!client.current)client.current=new AiPanelWorkflow(kind,tenantId??'',leadId,requestApi,setState,{
  canStart:()=>callbacks.current.boundary.canStart?.()!==false,
  onStateChange:next=>callbacks.current.boundary.onStateChange?.(next),
  onAccessDenied:error=>{callbacks.current.clearPrivate();callbacks.current.boundary.onAccessDenied?.(error);},
 });
 const workflow=client.current;
 useEffect(()=>{workflow.open();if(tenantId)void workflow.refresh();return()=>workflow.close();},[workflow,tenantId]);
 const previousVersion=useRef(leadVersion);
 useEffect(()=>{if(previousVersion.current!==leadVersion){previousVersion.current=leadVersion;if(tenantId&&!workflow.state.busy&&!workflow.recovery.pending)void workflow.refresh();}},[leadVersion,tenantId,workflow]);
 const queued=state.data?.jobs.some(j=>['QUEUED','RUNNING'].includes(j.state));
 useEffect(()=>{if(!tenantId||!queued||state.busy||state.pending||!state.ready)return;const timer=setInterval(()=>{if(!document.hidden&&!workflow.state.busy&&!workflow.recovery.pending)void workflow.refresh();},30000);return()=>clearInterval(timer);},[tenantId,queued,state.busy,state.pending,state.ready,workflow]);
 return {...state,workflow,blocked:state.busy||!!state.pending||!state.ready};
}
