'use client';
import {useRef,useState} from 'react';
import CsvImportPanel from './csv-import-panel';
import WebsiteIntegrationsPanel from './website-integrations-panel';
type Props={tenantId?:string;userRole:string;onChanged:()=>void;integrationsOnly?:boolean;onLock?:(value:boolean)=>void};
export default function CapturePanel(props:Props){return <CaptureTabs key={JSON.stringify([props.tenantId,props.userRole,props.integrationsOnly])} {...props}/>;}
function CaptureTabs({tenantId,userRole,onChanged,integrationsOnly=false,onLock:parentLock}:Props){
 const [tab,setTab]=useState(integrationsOnly?'Website integrations':'CSV import'),[locked,setLocked]=useState(false),lock=useRef(false);
 function onLock(value:boolean){lock.current=value;setLocked(value);parentLock?.(value);}
 if(userRole==='AGENT')return <section className="panel"><h2>Agency lead capture</h2><p>Managers manage CSV imports and signed website integrations. Use Add lead to capture your own inquiry.</p></section>;
 if(!tenantId)return <section className="panel"><h2>Capture every inquiry.</h2><p>CSV imports and website integrations require a connected agency. Manual leads and confirmed facts are available in the session preview.</p></section>;
 return <><div className="detail-tabs">{(integrationsOnly?['Website integrations']:['CSV import','Website integrations']).map(v=><button key={v} aria-pressed={tab===v} disabled={locked} onClick={()=>{if(!lock.current)setTab(v);}}>{v}</button>)}</div>{tab==='CSV import'?<CsvImportPanel tenantId={tenantId} role={userRole} onChanged={onChanged} onLock={onLock}/>:<WebsiteIntegrationsPanel tenantId={tenantId} role={userRole} onLock={onLock}/>}</>;
}
