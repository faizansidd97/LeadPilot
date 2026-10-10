import {z} from 'zod';
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const operationsAlert=z.enum(['REMINDERS_DELAYED','NOTIFICATION_QUEUE_DELAYED','AI_QUEUE_DELAYED','FAILED_NOTIFICATION_JOBS','FAILED_AI_JOBS','AI_USAGE_RECONCILIATION','EXPIRED_WORKER_LEASES']);
export const operationsSnapshotSchema=z.object({captured_at:z.iso.datetime({offset:true}),lag_alert_seconds:z.literal(900),reminders:z.object({awaiting_creation:count,oldest_due_seconds:count}).strict(),notifications:z.object({pending:count,running:count,failed:count,expired_leases:count,oldest_pending_seconds:count}).strict(),ai:z.object({queued:count,running:count,failed:count,expired_leases:count,oldest_pending_seconds:count,reconciliation:count}).strict(),alerts:z.array(operationsAlert).max(7),cost_amount:z.null(),scheduler_verified:z.literal(false)}).strict();
export type OperationsSnapshot=z.infer<typeof operationsSnapshotSchema>;
export const operationsAlertLabels:Record<z.infer<typeof operationsAlert>,string>={
 REMINDERS_DELAYED:'Due reminders have awaited creation for over 15 minutes.',NOTIFICATION_QUEUE_DELAYED:'Notification or invitation jobs have waited over 15 minutes.',AI_QUEUE_DELAYED:'Analysis or draft jobs have waited over 15 minutes.',FAILED_NOTIFICATION_JOBS:'Retained notification or invitation jobs have exhausted retries.',FAILED_AI_JOBS:'Retained analysis or draft jobs failed.',AI_USAGE_RECONCILIATION:'AI operations need usage reconciliation.',EXPIRED_WORKER_LEASES:'Running jobs have expired leases and await worker recovery.',
};
