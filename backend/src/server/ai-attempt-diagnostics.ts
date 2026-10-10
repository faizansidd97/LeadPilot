import {z} from 'zod';
import {aiAttemptDiagnosticsSchema} from '../domain/ai-attempts.ts';
import {ApiError} from './http.ts';
import type {WorkerDb} from './notification-worker.ts';
export async function readAiAttemptDiagnostics(db:WorkerDb,jobId:string) {
 const job=z.uuid().parse(jobId);
 const result=await db.rpc('worker_ai_attempt_diagnostics',{p_job:job});
 if(result.error)throw new ApiError(503,'ATTEMPT_DIAGNOSTICS_UNAVAILABLE','Private attempt diagnostics are unavailable.');
 const report=aiAttemptDiagnosticsSchema.safeParse(result.data);
 if(!report.success||report.data.job_id!==job)throw new ApiError(503,'ATTEMPT_DIAGNOSTICS_UNAVAILABLE','Private attempt diagnostics are unavailable.');
 return report.data;
}
