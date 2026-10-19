'use client';

import RecoveryScreen from '@/components/recovery-screen';
import styles from '@/components/recovery-screen.module.css';

export default function GlobalError({retry}:{retry:()=>void}){
 return <html lang="en"><head><title>Workspace unavailable · LeadPilot</title></head><body className={styles.document}>
  <RecoveryScreen kind="error" onRetry={retry}/>
 </body></html>;
}
