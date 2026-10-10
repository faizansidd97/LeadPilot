import {z} from 'zod';
import {operationsAlert} from './operations.ts';
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const healthShape=z.object({
 database:z.literal('REACHABLE'),captured_at:z.iso.datetime({offset:true}),lag_alert_seconds:z.literal(900),
 due_lag_seconds:count,outbox_lag_seconds:count,ai_lag_seconds:count,
 outbox_pending:count,outbox_failed:count,outbox_expired_leases:count,
 ai_pending:count,ai_failed:count,ai_expired_leases:count,
 reserved_operations:count,reconcile_operations:count,observed_tokens_month:count,
 cost_amount:z.null(),privacy_pending:count,privacy_execution_available:z.literal(false),
 scheduler_verified:z.literal(false),alert:z.boolean(),
}).strict();
export type PlatformHealth=z.infer<typeof healthShape>;
export function platformHealthAlerts(health:PlatformHealth):z.infer<typeof operationsAlert>[] {
 const alerts:z.infer<typeof operationsAlert>[]=[];
 if(health.due_lag_seconds>900)alerts.push('REMINDERS_DELAYED');
 if(health.outbox_lag_seconds>900)alerts.push('NOTIFICATION_QUEUE_DELAYED');
 if(health.ai_lag_seconds>900)alerts.push('AI_QUEUE_DELAYED');
 if(health.outbox_failed>0)alerts.push('FAILED_NOTIFICATION_JOBS');
 if(health.ai_failed>0)alerts.push('FAILED_AI_JOBS');
 if(health.reconcile_operations>0)alerts.push('AI_USAGE_RECONCILIATION');
 if(health.outbox_expired_leases>0||health.ai_expired_leases>0)alerts.push('EXPIRED_WORKER_LEASES');
 return alerts;
}
export const platformHealthSchema=healthShape.superRefine((health,ctx)=>{
 if(health.alert!==(platformHealthAlerts(health).length>0)||
    health.outbox_expired_leases>health.outbox_pending||health.ai_expired_leases>health.ai_pending||
    (health.outbox_pending===0&&health.outbox_lag_seconds!==0)||(health.ai_pending===0&&health.ai_lag_seconds!==0)) {
  ctx.addIssue({code:'custom',message:'Inconsistent health snapshot.'});
 }
});
