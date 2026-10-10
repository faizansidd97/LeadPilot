import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deliverQueuedInvitation} from '../src/server/queued-invitation.ts';
import {invitationToken,tokenHash} from '../src/server/invitations.ts';
import {authorizeWorker} from '../src/server/worker-auth.ts';
import {runNotifications,type WorkerDb} from '../src/server/notification-worker.ts';
import {notificationSchema,notificationListSchema} from '../src/domain/notifications.ts';
import {api,ApiError} from '../src/server/http.ts';
test('cron is separately authenticated and fails closed before missing or invalid credentials',()=>{
 const secret='b'.repeat(64);assert.throws(()=>authorizeWorker(new Request('https://app.example'),undefined),/configuration/);assert.throws(()=>authorizeWorker(new Request('https://app.example',{headers:{Cookie:'session=trusted'}}),secret),/authorization/);assert.throws(()=>authorizeWorker(new Request('https://app.example',{headers:{Authorization:'Bearer wrong'}}),secret),/authorization/);assert.doesNotThrow(()=>authorizeWorker(new Request('https://app.example',{headers:{Authorization:'Bearer '+secret}}),secret));
});
test('worker bounds scans and claims; no more than twenty jobs or unstarted bulk leases',async()=>{
 const calls:{name:string;args?:Record<string,unknown>}[]=[];const db:WorkerDb={rpc:async(name,args)=>{calls.push({name,args});if(name==='worker_seed_due')return {data:{seeded:100},error:null};if(name==='worker_claim_notifications')return {data:[{id:crypto.randomUUID(),lease_token:crypto.randomUUID()}],error:null};if(name==='worker_finish_notification')return {data:{state:'SUCCEEDED',written:1},error:null};return {data:{due_lag_seconds:0},error:null};}};
 const result=await runNotifications(db,true,()=>100);assert.equal(result.jobs.length,20);assert.equal(result.seeded,100);assert.equal(calls.filter(c=>c.name==='worker_claim_notifications').every(c=>c.args?.p_limit===1),true);assert.equal(calls[0].args?.p_limit,100);
 let stamp=0;const limited=await runNotifications(db,false,()=>stamp+=10000);assert.equal(limited.jobs.length,1);
});
test('worker failure is sanitized, retry persistence is explicit and network loss keeps lease recovery',async()=>{
 let claims=0;const db:WorkerDb={rpc:async(name,args)=>{if(name==='worker_claim_notifications')return {data:claims++?[ ]:[{id:'job',lease_token:'lease'}],error:null};if(name==='worker_finish_notification')return {data:null,error:{message:'sensitive provider body and password'}};if(name==='worker_fail_notification'){assert.equal(args?.p_code,'NOTIFICATION_WRITE_FAILED');return {data:{state:'PENDING'},error:null};}return {data:{alert:false},error:null};}};
 const result=await runNotifications(db,false,()=>0);assert.deepEqual(result.jobs,[{id:'job',state:'PENDING',written:0}]);assert.equal(JSON.stringify(result).includes('password'),false);
 claims=0;const lost:WorkerDb={rpc:async(name,args)=>{if(name==='worker_finish_notification'||name==='worker_fail_notification')throw new Error('secret');return db.rpc(name,args);}};assert.equal((await runNotifications(lost,false,()=>0)).jobs[0].state,'LEASE_RECOVERY_PENDING');
});
test('notification payload and filters reject recipient injection, false flags and unbounded pages',()=>{
 assert.equal(notificationSchema.safeParse({expected_version:1,read:true}).success,true);for(const input of [{expected_version:1},{expected_version:1,read:false},{expected_version:1,dismiss:true,recipient_id:crypto.randomUUID()}])assert.equal(notificationSchema.safeParse(input).success,false);assert.equal(notificationListSchema.safeParse({limit:101}).success,false);
});
test('rate-limited HTTP responses expose safe retry metadata and never cache the failure',async()=>{
 const response=await api(async()=>{const error=new ApiError(429,'RATE_LIMITED','Wait and retry.');error.retryAfter=12;throw error;});assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'12');assert.equal(response.headers.get('Cache-Control'),'private, no-store');const body=await response.json();assert.equal(body.error.retryable,true);assert.equal(body.error.retry_after,12);
});

test('durable invitation worker regenerates a private link and uses a stable transport key without returning it',async()=>{
 const names=['INVITATION_TOKEN_SECRET','INVITATION_MAIL_URL','INVITATION_MAIL_TOKEN','APP_URL'] as const,saved=names.map(name=>process.env[name]);
 try{process.env.INVITATION_TOKEN_SECRET='c'.repeat(64);process.env.INVITATION_MAIL_URL='https://mail.example';process.env.INVITATION_MAIL_TOKEN='test-only';process.env.APP_URL='https://app.example';
 const context={available:true,to:'invited@example.com',tenant_id:'tenant',actor_id:'actor',token_operation:'create:',request_key:'key',token_hash:tokenHash(invitationToken(process.env.INVITATION_TOKEN_SECRET,'tenant','actor','create:','key'))};let outcome='';let calls=0;
 const db:WorkerDb={rpc:async(name,args)=>name==='worker_prepare_invitation_mail'?{data:context,error:null}:(outcome=String(args?.p_result),{data:{state:'SUCCEEDED',written:0},error:null})};
 const adapter:typeof import('../src/server/invitations.ts').deliverInvitation=async(to,link,key)=>{calls++;assert.equal(to,'invited@example.com');assert.equal(new URL(link).pathname,'/join');assert.match(new URL(link).hash,/^#token=[a-f0-9]{64}$/);assert.equal(key,'invitation-mail:job-id');return 'EMAIL_ACCEPTED';};
 assert.deepEqual(await deliverQueuedInvitation(db,{id:'job-id',lease_token:'lease'},adapter),{state:'SUCCEEDED',written:0});assert.equal(outcome,'EMAIL_ACCEPTED');assert.equal(calls,1);
 context.token_hash='0'.repeat(64);await deliverQueuedInvitation(db,{id:'job-id',lease_token:'lease'},adapter);assert.equal(outcome,'TOKEN_ROTATED');assert.equal(calls,1);
 }finally{names.forEach((name,i)=>{if(saved[i]===undefined)delete process.env[name];else process.env[name]=saved[i];});}
});
test('queued email skips unavailable/unconfigured delivery and transport errors stay retryable',async()=>{
 const names=['INVITATION_TOKEN_SECRET','INVITATION_MAIL_URL','INVITATION_MAIL_TOKEN','APP_URL'] as const,saved=names.map(name=>process.env[name]);let outcome='',available=false;
 const context={to:'invited@example.com',tenant_id:'tenant',actor_id:'actor',token_operation:'create:',request_key:'key',token_hash:tokenHash(invitationToken('c'.repeat(64),'tenant','actor','create:','key'))};
 const db:WorkerDb={rpc:async(name,args)=>name==='worker_prepare_invitation_mail'?{data:{...context,available},error:null}:(outcome=String(args?.p_result),{data:{state:'CANCELLED'},error:null})};
 try{delete process.env.INVITATION_MAIL_URL;await deliverQueuedInvitation(db,{id:'job',lease_token:'lease'});assert.equal(outcome,'INVITATION_UNAVAILABLE');available=true;await deliverQueuedInvitation(db,{id:'job',lease_token:'lease'});assert.equal(outcome,'LINK_ONLY');
 process.env.INVITATION_TOKEN_SECRET='c'.repeat(64);process.env.INVITATION_MAIL_URL='https://mail.example';process.env.INVITATION_MAIL_TOKEN='test-only';process.env.APP_URL='https://app.example';await assert.rejects(()=>deliverQueuedInvitation(db,{id:'job',lease_token:'lease'},async()=> 'EMAIL_FAILED'),/retried/);
 }finally{names.forEach((name,i)=>{if(saved[i]===undefined)delete process.env[name];else process.env[name]=saved[i];});}
});

test('mail failure uses the same durable retry path and excludes recipient context from worker output',async()=>{
 let claimed=false,code='';const db:WorkerDb={rpc:async(name,args)=>{if(name==='worker_claim_notifications'){const data=claimed?[]:[{id:'mail-job',lease_token:'lease',event_type:'INVITATION_MAIL'}];claimed=true;return {data,error:null};}if(name==='worker_fail_notification'){code=String(args?.p_code);return {data:{state:'PENDING'},error:null};}return {data:{alert:false},error:null};}};
 const result=await runNotifications(db,false,()=>0,async()=>{throw new ApiError(503,'INVITATION_MAIL_FAILED','Delivery will be retried.');});assert.equal(code,'INVITATION_MAIL_FAILED');assert.deepEqual(result.jobs,[{id:'mail-job',state:'PENDING',written:0}]);
});
