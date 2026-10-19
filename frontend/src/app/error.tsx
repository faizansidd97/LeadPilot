'use client';

import RecoveryScreen from '@/components/recovery-screen';

export default function ErrorPage({retry}:{retry:()=>void}){
 return <RecoveryScreen kind="error" onRetry={retry}/>;
}
