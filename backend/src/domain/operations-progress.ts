import {z} from 'zod';
import {operationsSnapshotSchema,type OperationsSnapshot} from './operations.ts';
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),limit=z.number().int().min(0).max(1000000).nullable();
export const analysisUsageSchema=z.object({daily_limit:limit,monthly_limit:limit,daily_operations:count,monthly_operations:count,reconciliation:count});
export type AnalysisUsage=z.infer<typeof analysisUsageSchema>;
export function verifyOperationsSnapshot(value:unknown):OperationsSnapshot {
 const s=operationsSnapshotSchema.parse(value),n=s.notifications,a=s.ai,r=s.reminders;
 if(n.expired_leases>n.running||a.expired_leases>a.running||(!r.awaiting_creation&&r.oldest_due_seconds)||(!n.pending&&!n.running&&n.oldest_pending_seconds)||(!a.queued&&!a.running&&a.oldest_pending_seconds))throw Error('Inconsistent queue snapshot.');
 const alerts:string[]=[];
 if(r.oldest_due_seconds>900)alerts.push('REMINDERS_DELAYED');if(n.oldest_pending_seconds>900)alerts.push('NOTIFICATION_QUEUE_DELAYED');if(a.oldest_pending_seconds>900)alerts.push('AI_QUEUE_DELAYED');if(n.failed)alerts.push('FAILED_NOTIFICATION_JOBS');if(a.failed)alerts.push('FAILED_AI_JOBS');if(a.reconciliation)alerts.push('AI_USAGE_RECONCILIATION');if(n.expired_leases||a.expired_leases)alerts.push('EXPIRED_WORKER_LEASES');
 if(s.alerts.length!==alerts.length||new Set(s.alerts).size!==s.alerts.length||alerts.some(code=>!s.alerts.includes(code as typeof s.alerts[number])))throw Error('Inconsistent queue alerts.');
 return s;
}
