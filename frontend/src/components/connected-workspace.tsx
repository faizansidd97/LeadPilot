'use client';
import { useEffect,useRef,useState } from 'react';
import Workspace,{ type Lead } from './workspace';
import { requestApi,toLead } from '@/lib/api-client';
import { ClientRequests,MutationRetry,type RequestTicket } from '@/lib/client-workflow';
import { loadWorkspaceSession,completeSessionSignOut,sessionFailurePhase,type Membership,type SessionSnapshot } from '@/lib/workspace-session';

type Phase='loading'|'login'|'onboard'|'agency'|'workspace'|'recovery'|'signout';
export default function ConnectedWorkspace(){
 const [phase,setPhase]=useState<Phase>('loading');
 const [memberships,setMemberships]=useState<Membership[]>([]);
 const [active,setActive]=useState<Membership|null>(null);
 const [leads,setLeads]=useState<Lead[]>([]);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const requests=useRef(new ClientRequests()),agencyRetry=useRef(new MutationRetry());
 const userId=useRef<string|null>(null),retryTenant=useRef<string|undefined>(undefined);
 const signOutPending=useRef(false);
 function clearWorkspace(){setLeads([]);setActive(null);setMemberships([]);}
 function resetLocation(){window.history.replaceState(null,'',window.location.pathname);}
 function fail(e:unknown,ticket:RequestTicket){
  if(!ticket.isCurrent())return;
  clearWorkspace();setError(e instanceof Error?e.message:'Workspace could not open. Please retry.');
  const next=sessionFailurePhase(e);
  if(next==='login'){agencyRetry.current.clear();userId.current=null;retryTenant.current=undefined;resetLocation();}
  setPhase(next);
 }
 function publish(snapshot:SessionSnapshot,ticket:RequestTicket){
  ticket.assertCurrent();
  // Convert before updating any React state so malformed lead data cannot publish a partial workspace.
  const mapped=snapshot.leads.map(toLead);
  if(userId.current&&userId.current!==snapshot.userId)agencyRetry.current.clear();
  userId.current=snapshot.userId;setMemberships(snapshot.memberships);setActive(snapshot.active);setLeads(mapped);
  setError('');setNotice('');
  setPhase(snapshot.active?'workspace':snapshot.memberships.length?'agency':'onboard');
 }
 async function boot(ticket:RequestTicket,tenant?:string,choose=false){
  ticket.assertCurrent();retryTenant.current=tenant;clearWorkspace();setError('');setNotice('');setPhase('loading');
  const snapshot=await loadWorkspaceSession(ticket,requestApi,{tenant,choose});publish(snapshot,ticket);
 }
 async function action(work:(ticket:RequestTicket)=>Promise<void>,failure=fail){
  const ticket=requests.current.beginAction();if(!ticket)return;
  setBusy(true);
  try{await work(ticket);}catch(e){failure(e,ticket);}finally{
   if(ticket.isCurrent())setBusy(false);requests.current.finishAction(ticket);
  }
 }
 useEffect(()=>{
  const ticket=requests.current.replace();setBusy(true);
  void boot(ticket).catch(e=>fail(e,ticket)).finally(()=>{if(ticket.isCurrent())setBusy(false);});
  return()=>requests.current.close();
 },[]);
 async function auth(form:HTMLFormElement,kind:'sign-in'|'sign-up'|'reset-password'){
  const data=new FormData(form);
  const body=kind==='reset-password'?{email:data.get('email')}:{email:data.get('email'),password:data.get('password')};
  let signedIn=false;
  await action(async ticket=>{
   setError('');setNotice('');
   const result=await requestApi('/api/v1/auth/'+kind,{method:'POST',body:JSON.stringify(body),signal:ticket.signal});ticket.assertCurrent();
   if(kind==='sign-in'){signedIn=true;agencyRetry.current.clear();userId.current=null;await boot(ticket);}
   else setNotice(result.message);
  },(e,ticket)=>{
   if(!ticket.isCurrent())return;
   if(signedIn)fail(e,ticket);else setError(e instanceof Error?e.message:'Request could not complete. Please retry.');
  });
 }
 async function createAgency(form:FormData){
  const body={name:form.get('name'),timezone:form.get('timezone'),locale:'en'};
  const account=userId.current;if(!account)return;
  await action(async ticket=>{
   setError('');setNotice('');
   await agencyRetry.current.run(account,'/api/v1/agencies','POST',body,ticket,
    key=>requestApi('/api/v1/agencies',{method:'POST',body:JSON.stringify(body),signal:ticket.signal},undefined,key),
    async()=>{const snapshot=await loadWorkspaceSession(ticket,requestApi,{expectedUser:account});publish(snapshot,ticket);});
  },(e,ticket)=>{
   if(!ticket.isCurrent())return;
   if(sessionFailurePhase(e)==='login'||(e as {status?:number})?.status===403){fail(e,ticket);return;}
   // Retain the entered form and its retry identity if the save or required refresh is uncertain.
   setError(e instanceof Error?e.message:'Agency creation could not complete. Retry the same details.');
  });
 }
 async function signOut(){
  await action(async ticket=>{
   signOutPending.current=true;agencyRetry.current.clear();userId.current=null;retryTenant.current=undefined;
   clearWorkspace();resetLocation();setPhase('signout');setError('');setNotice('');
   await completeSessionSignOut(ticket,requestApi);
   signOutPending.current=false;setPhase('login');
  },(e,ticket)=>{if(ticket.isCurrent()){clearWorkspace();setPhase('signout');setError(e instanceof Error?e.message:'Sign out could not complete. Please retry.');}});
 }
 function reopen(tenant?:string,choose=false){
  if(signOutPending.current)return;
  void action(ticket=>boot(ticket,tenant,choose));
 }
 if(phase==='workspace'&&active)return <Workspace key={`${userId.current}:${active.tenant_id}:${active.role}`} actorId={userId.current??undefined} initialLeads={leads} tenantId={active.tenant_id} agencyName={active.agencies.name} agencyTimezone={active.agencies.timezone} userRole={active.role} onContextRefresh={()=>reopen(active.tenant_id)} onSignOut={signOut} onSwitchAgency={memberships.length>1?()=>{resetLocation();reopen(undefined,true);}:undefined}/>;
 return <div className="auth-shell"><section className="dialog" aria-busy={busy}><a className="brand" href="/">LeadPilot <span className="ai">AI</span></a><h1>{phase==='loading'?'Opening your workspace…':phase==='login'?'Welcome to LeadPilot':phase==='onboard'?'Create your agency':phase==='recovery'?'Workspace unavailable':phase==='signout'?'Complete sign out':'Choose your agency'}</h1>{error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status">{notice}</p>}
 {phase==='login'&&<form onSubmit={e=>{e.preventDefault();void auth(e.currentTarget,'sign-in');}}><label>Email<input required name="email" type="email" autoComplete="email"/></label><label>Password<input required name="password" type="password" minLength={8} autoComplete="current-password"/></label><button className="primary" disabled={busy}>{busy?'Please wait…':'Sign in'}</button><div className="auth-actions"><button type="button" disabled={busy} onClick={e=>void auth(e.currentTarget.form!,'sign-up')}>Create account</button><button type="button" disabled={busy} onClick={e=>void auth(e.currentTarget.form!,'reset-password')}>Reset password</button></div><small>Verify your email before opening an agency workspace.</small></form>}
 {phase==='onboard'&&<form onSubmit={e=>{e.preventDefault();void createAgency(new FormData(e.currentTarget));}}><label>Agency name<input required name="name" minLength={2} maxLength={120}/></label><label>IANA timezone<input required name="timezone" defaultValue="Asia/Dubai"/></label><button className="primary" disabled={busy}>{busy?'Creating…':'Create agency'}</button></form>}
 {phase==='agency'&&memberships.map(m=><button className="agency-choice" key={m.id} disabled={busy} onClick={()=>reopen(m.tenant_id)}>{m.agencies.name} · {m.role}</button>)}
 {phase==='recovery'&&<><p>Your workspace could not be verified. Retry opening it, or refresh your agency list if your access changed.</p><button className="primary" disabled={busy} onClick={()=>reopen(retryTenant.current)}>Retry opening workspace</button><button disabled={busy} onClick={()=>reopen(undefined,true)}>Refresh agency list</button></>}
 {phase==='signout'&&<><p>Workspace data is hidden. Sign out must complete before another account can open here.</p><button className="primary" disabled={busy} onClick={()=>void signOut()}>{busy?'Signing out…':'Retry sign out'}</button></>}
 {(phase==='agency'||phase==='onboard'||phase==='recovery')&&<button className="text-button" disabled={busy} onClick={()=>void signOut()}>Sign out</button>}
 </section></div>;
}
