'use client';

import {useEffect,useRef} from 'react';
import styles from './recovery-screen.module.css';

type Props={kind:'error'|'not-found';onRetry?:()=>void};

export default function RecoveryScreen({kind,onRetry}:Props){
 const heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{heading.current?.focus();},[]);
 const missing=kind==='not-found';

 return <main className={styles.screen} aria-labelledby="recovery-title">
  <div className={styles.container}>
   <a className={styles.brand} href="/" aria-label="Open LeadPilot workspace"><span aria-hidden="true">↗</span>LeadPilot <small>AI</small></a>
   <section className={styles.card}>
    <span className={styles.eyebrow}>{missing?'PAGE NOT FOUND':'WORKSPACE RECOVERY'}</span>
    <h1 id="recovery-title" ref={heading} tabIndex={-1}>{missing?'That page couldn’t be found':'We couldn’t open this screen'}</h1>
    <p>{missing?'The link may be incomplete or the page may no longer be available. Open your workspace to continue.':'An unexpected error interrupted this screen. You can try loading it again or open your workspace.'}</p>
    {!missing&&<div className={styles.notice}>
     <h2>Before trying a change again</h2>
     <p>If you were saving, the change may already be saved. Check the latest record in your workspace before submitting it again. Unsaved text may need to be entered again.</p>
    </div>}
    <div className={styles.actions}>
     {!missing&&onRetry&&<button type="button" onClick={onRetry}>Try loading again</button>}
     <a className={!missing&&onRetry?styles.secondary:styles.primary} href="/">Open workspace <span aria-hidden="true">↗</span></a>
    </div>
    {!missing&&<p className={styles.help}>If this keeps happening, note what you were doing and when it happened so it can be investigated.</p>}
   </section>
  </div>
 </main>;
}
