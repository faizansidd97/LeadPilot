'use client';
import {useEffect,useRef,useState} from 'react';
import {requestApi} from '@/lib/api-client';
import {ClientRequests,type RequestTicket} from '@/lib/client-workflow';
import {enrollAuthenticator,readMfaSnapshot,verifyAuthenticator,type MfaFactor,type MfaEnrollment,type MfaSnapshot} from '@/lib/account-recovery';
type Props={context?:'profile'|'privacy';disabled?:boolean;canStart?:()=>boolean;onBusyChange?:(busy:boolean)=>void;onVerified?:()=>void;onAccessDenied?:(error:unknown)=>void};
export default function MfaSettings({context='profile',disabled=false,...callbacks}:Props){
 const [factors,setFactors]=useState<MfaFactor[]>([]),[factor,setFactor]=useState(''),[setup,setSetup]=useState<MfaEnrollment|null>(null);
 const [busy,setBusy]=useState(false),[ready,setReady]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [code,setCode]=useState('');
 const requests=useRef(new ClientRequests()),options=useRef({disabled,...callbacks});options.current={disabled,...callbacks};
 function working(value:boolean){setBusy(value);options.current.onBusyChange?.(value);}
 function confirmed(ticket:RequestTicket){ticket.assertCurrent();setCode('');options.current.onVerified?.();}
 function clearPrivate(){setFactors([]);setFactor('');setSetup(null);setCode('');setReady(false);setNotice('');}
 function publish(data:MfaSnapshot,ticket:RequestTicket){
  ticket.assertCurrent();setFactors(data.factors);setReady(true);
  setFactor(current=>data.factors.some(f=>f.id===current)?current:data.factors[0]?.id||'');
  setSetup(current=>current&&data.factors.some(f=>f.id===current.factor_id&&f.status==='unverified')?current:null);
  setNotice(data.recent?'Recent verification is active for sensitive actions.':context==='privacy'?'Verify here, then submit your privacy request or review. Your input stays in this page.':'Use an authenticator code before sensitive changes.');
 }
 async function load(ticket:RequestTicket){const data=await readMfaSnapshot(ticket,requestApi);publish(data,ticket);return data;}
 function fail(e:unknown,ticket:RequestTicket){
  if(!ticket.isCurrent())return;
  if([401,403].includes((e as {status?:number})?.status??0)){clearPrivate();options.current.onAccessDenied?.(e);}
  setError(e instanceof Error?e.message:'Authenticator settings could not load. Please refresh.');
 }
 useEffect(()=>{
  if(options.current.canStart?.()===false)return()=>requests.current.close();
  const ticket=requests.current.replace();working(true);
  void load(ticket).catch(e=>{if(ticket.isCurrent()){clearPrivate();fail(e,ticket);}}).finally(()=>{if(ticket.isCurrent())working(false);});
  return()=>{requests.current.close();options.current.onBusyChange?.(false);};
 },[]);
 async function refresh(){
  if(options.current.disabled||options.current.canStart?.()===false)return;const ticket=requests.current.beginAction();if(!ticket)return;working(true);setError('');
  try{const data=await load(ticket);if(data.recent&&data.factors.some(f=>f.status==='verified'))confirmed(ticket);}catch(e){if(ticket.isCurrent()){clearPrivate();fail(e,ticket);}}finally{if(ticket.isCurrent())working(false);requests.current.finishAction(ticket);}
 }
 async function run(action:'enroll'|'verify'|'cancel-pending',code?:string):Promise<boolean>{
  if(options.current.disabled||options.current.canStart?.()===false)return false;const ticket=requests.current.beginAction();if(!ticket)return false;working(true);setError('');setNotice('');
  try{
   if(action==='enroll'){
    if(uncertain)throw Error('Refresh factors and clear the unfinished setup before enrolling again.');
    const data=await enrollAuthenticator(ticket,requestApi,snapshot=>publish(snapshot,ticket));ticket.assertCurrent();
    setSetup(data);setFactor(data.factor_id);setUncertain(false);setNotice('Scan the QR code in your authenticator, then verify the first code.');
   }else if(action==='verify'){
    const snapshot=await verifyAuthenticator(ticket,requestApi,factor,code??'');publish(snapshot,ticket);ticket.assertCurrent();
    setSetup(null);setUncertain(false);setNotice('Authenticator verified. Complete the sensitive action within five minutes.');confirmed(ticket);
   }else{
    const data=await requestApi('/api/v1/me/mfa',{method:'POST',signal:ticket.signal,body:JSON.stringify({action,factor_id:factor})});ticket.assertCurrent();
    setSetup(null);setReady(false);
    if(typeof data?.message!=='string')throw Error('Authenticator update could not be confirmed. Refresh factors before continuing.');
    const snapshot=await load(ticket);ticket.assertCurrent();setUncertain(false);
    if(action==='cancel-pending'||snapshot.recent)setNotice(data.message);
   }
   return true;
  }catch(e){
   if(!ticket.isCurrent())return false;
   if(action==='enroll'&&(e as {uncertain?:boolean})?.uncertain){
    setUncertain(true);setSetup(null);setReady(false);
    // Recover only the factor inventory. A second enrollment POST is never an automatic retry.
    try{await load(ticket);}catch(readError){if(ticket.isCurrent())clearPrivate();fail(readError,ticket);}
   }
   fail(e,ticket);return false;
   }finally{if(ticket.isCurrent())working(false);requests.current.finishAction(ticket);}
 }
 return <section className="settings-section mfa-settings" aria-busy={busy}>
  <div className="mfa-heading"><h2>{context==='privacy'?'Verify for privacy changes':'Account security'}</h2><button type="button" className="text-button" disabled={busy||disabled} onClick={()=>void refresh()}>Refresh authenticators</button></div>
  {notice&&<p role="status">{notice}</p>}
  {error&&<p role="alert" className="error">{error}</p>}
  {!ready&&busy&&<p role="status">Loading authenticator settings…</p>}
  {!ready&&!busy&&<p>Authenticator settings are unavailable. Refresh authenticators to try again.</p>}
  <fieldset disabled={disabled} style={{border:0,padding:0,margin:0,minWidth:0}}>
   {uncertain&&<p>Setup could not be confirmed. Refresh authenticators, then clear an unfinished setup or verify an existing authenticator. If none appears, reopen account security before trying again.</p>}
   {ready&&!setup&&factors.length===0&&<div className="mfa-onboarding">
    <h3>No authenticator set up yet</h3>
    <p>Connect an authenticator app on your phone to get the six-digit codes needed for sensitive changes.</p>
    <ol><li>Start setup to show your QR code.</li><li>Scan it with your authenticator app.</li><li>Enter the code from the app to finish connecting.</li></ol>
    <button type="button" className="primary" disabled={busy||uncertain} onClick={()=>void run('enroll')}>{busy?'Starting setup…':'Set up authenticator'}</button>
   </div>}
   {ready&&!setup&&factors.length>0&&<div className="mfa-factor">
    <label>Authenticator<select value={factor} disabled={busy} onChange={e=>{setFactor(e.target.value);setCode('');}}><option value="">Select authenticator</option>{factors.map(f=><option key={f.id} value={f.id}>{f.friendly_name??'Authenticator'} · {f.status==='verified'?'Connected':'Setup unfinished'}</option>)}</select></label>
    {factors.some(f=>f.id===factor&&f.status==='unverified')&&<div className="mfa-onboarding"><p>This setup is unfinished. If you already scanned its QR code, enter the code from your app below. Otherwise, clear it and start setup again.</p><button type="button" className="text-button" disabled={busy} onClick={()=>void run('cancel-pending')}>Clear unfinished setup</button></div>}
   </div>}
   {setup&&<div className="mfa-setup mfa-onboarding">
    <h3>Connect your authenticator app</h3><p>Open the app on your phone, add an account and scan this QR code. Then enter its current six-digit code below.</p>
    {/* Auth QR is an image; private setup data stays in mounted memory. */}
    <img src={setup.qr_code} alt="Authenticator enrollment QR code" width={200} height={200}/>
    <details><summary>Cannot scan? Use the manual setup key</summary><code>{setup.secret}</code></details><p>Keep this setup key private.</p>
    <button type="button" className="text-button" disabled={busy} onClick={()=>void run('cancel-pending')}>Cancel setup</button>
   </div>}
   {ready&&factor&&<form onSubmit={e=>{e.preventDefault();void run('verify',code);}}><label>Current six-digit code<input required name="code" value={code} onChange={e=>setCode(e.target.value)} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" readOnly={busy}/></label><button type="submit" className="primary" disabled={busy}>{busy?'Verifying…':setup?'Finish setup':'Verify authenticator'}</button></form>}
  </fieldset>
 </section>;
}
