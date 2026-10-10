'use client';
import {useEffect,useRef,useState} from 'react';
import {requestApi} from '@/lib/api-client';
import {ClientRequests,MutationRetry,type RequestTicket} from '@/lib/client-workflow';
import {completeSessionSignOut} from '@/lib/workspace-session';
import {InvitationFragment,readVerifiedAccount,verifyInvitationReceipt,type VerifiedAccount} from '@/lib/account-recovery';
import MfaSettings from './mfa-settings';
type Phase='loading'|'login'|'account'|'recovery'|'signout'|'accepted';
export default function JoinInvitation({configured}:{configured:boolean}){
 const [token,setToken]=useState(''),[account,setAccount]=useState<VerifiedAccount|null>(null),[phase,setPhase]=useState<Phase>('loading');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const fragment=useRef(new InvitationFragment()),requests=useRef(new ClientRequests()),attempt=useRef(new MutationRetry());
 const signoutPending=useRef(false),accountId=useRef<string|null>(null);
 function fail(e:unknown,ticket:RequestTicket){
  if(!ticket.isCurrent())return;
  setError(e instanceof Error?e.message:'Request could not complete. Please retry.');
  if((e as {status?:number})?.status===401){setAccount(null);accountId.current=null;attempt.current.clear();setPhase('login');}
 }
 async function refreshAccount(ticket:RequestTicket){
  const current=await readVerifiedAccount(ticket,requestApi);ticket.assertCurrent();
  if(accountId.current!==current.id)attempt.current.clear();accountId.current=current.id;setAccount(current);
  setPhase('account');setError('');setNotice('');
 }
 async function action(work:(ticket:RequestTicket)=>Promise<void>,failure=fail){
  const ticket=requests.current.beginAction();if(!ticket)return;setBusy(true);
  try{await work(ticket);}catch(e){failure(e,ticket);}finally{if(ticket.isCurrent())setBusy(false);requests.current.finishAction(ticket);}
 }
 useEffect(()=>{
  const ticket=requests.current.replace();
  let value='';
  try{value=fragment.current.read(location.hash,()=>history.replaceState(null,'','/join'));setToken(value);}
  catch{setError('Invitation link could not be cleared from address history. Reopen the original link.');setPhase('recovery');return()=>requests.current.close();}
  if(!value){setError('Open the complete invitation link provided by your agency.');setPhase('recovery');}
  else if(configured){
   setPhase('loading');setBusy(true);
   void refreshAccount(ticket).catch(e=>{
    if(!ticket.isCurrent())return;
    setAccount(null);setPhase((e as {status?:number})?.status===401?'login':'recovery');
    if((e as {status?:number})?.status!==401)setError(e instanceof Error?e.message:'Account details could not load.');
   }).finally(()=>{if(ticket.isCurrent())setBusy(false);});
  }else setPhase('recovery');
  return()=>requests.current.close();
 },[configured]);
 async function auth(form:HTMLFormElement,kind:'sign-in'|'sign-up'){
  const values=new FormData(form),body={email:values.get('email'),password:values.get('password')};let signedIn=false;
  await action(async ticket=>{
   setError('');setNotice('');
   await requestApi('/api/v1/auth/'+kind,{method:'POST',signal:ticket.signal,body:JSON.stringify(body)});ticket.assertCurrent();
   if(kind==='sign-in'){signedIn=true;attempt.current.clear();setAccount(null);accountId.current=null;await refreshAccount(ticket);}
   else setNotice('Verify your account using the email message, then reopen the original agency invitation link to sign in.');
  },(e,ticket)=>{if(!ticket.isCurrent())return;fail(e,ticket);if(signedIn&&(e as {status?:number})?.status!==401){setAccount(null);setPhase('recovery');}});
 }
 async function accept(form:FormData){
  if(!account||!token||signoutPending.current)return;
  const body={token,display_name:form.get('name')},identity=account.id;
  await action(async ticket=>{
   setError('');setNotice('');
   await readVerifiedAccount(ticket,requestApi,identity);
   await attempt.current.run(identity,'/api/v1/team/invitations/accept','POST',body,ticket,
    key=>requestApi('/api/v1/team/invitations/accept',{method:'POST',signal:ticket.signal,body:JSON.stringify(body)},undefined,key),
    async data=>{verifyInvitationReceipt(data);});
   ticket.assertCurrent();fragment.current.clear();setToken('');setAccount(null);setPhase('accepted');
  });
 }
 async function differentAccount(){
  await action(async ticket=>{
   signoutPending.current=true;attempt.current.clear();setAccount(null);accountId.current=null;setPhase('signout');setError('');setNotice('');
   await completeSessionSignOut(ticket,requestApi);ticket.assertCurrent();signoutPending.current=false;setPhase('login');
  },(e,ticket)=>{if(ticket.isCurrent()){setAccount(null);setPhase('signout');setError(e instanceof Error?e.message:'Sign out could not complete. Please retry.');}});
 }
 return <div className="auth-shell"><section className="dialog join-dialog" aria-busy={busy}><a className="brand" href="/">LeadPilot <span className="ai">AI</span></a><h1>{phase==='accepted'?'Welcome to your agency':phase==='loading'?'Checking your account…':'Join your agency'}</h1>{!configured&&<p className="error">Supabase is not connected. Invitation acceptance requires a verified account and the configured backend.</p>}{error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status">{notice}</p>}
 {phase==='accepted'?<><p>Your invitation was accepted.</p><a className="primary" href="/">Open workspace</a></>:configured&&token&&<>
 {phase==='account'&&account&&<><p>Signed in as {account.email}. This verified email must match the invitation.</p><form onSubmit={e=>{e.preventDefault();void accept(new FormData(e.currentTarget));}}><label>Your agency display name<input required name="name" minLength={2} maxLength={120}/></label><button className="primary" disabled={busy}>Accept invitation</button></form><button className="text-button" disabled={busy} onClick={()=>void differentAccount()}>Use a different account</button><details><summary>Authenticator verification for an admin invitation</summary><MfaSettings key={account.id}/></details></>}
 {phase==='login'&&<form onSubmit={e=>{e.preventDefault();void auth(e.currentTarget,'sign-in');}}><p>Sign in with the invited email. New users must verify their email before accepting.</p><label>Email<input name="email" type="email" autoComplete="email" required/></label><label>Password<input name="password" type="password" autoComplete="current-password" minLength={8} required/></label><button className="primary" disabled={busy}>Sign in</button><button className="text-button" type="button" disabled={busy} onClick={e=>void auth(e.currentTarget.form!,'sign-up')}>Create an account</button></form>}
 {phase==='recovery'&&<button className="primary" disabled={busy} onClick={()=>void action(refreshAccount,(e,ticket)=>{fail(e,ticket);if(ticket.isCurrent()&&(e as {status?:number})?.status!==401)setPhase('recovery');})}>Retry account check</button>}
 {phase==='signout'&&<><p>Complete sign out before using another account.</p><button className="primary" disabled={busy} onClick={()=>void differentAccount()}>Retry sign out</button></>}
 </>}<p><a href="/">Back to workspace</a></p></section></div>;
}
