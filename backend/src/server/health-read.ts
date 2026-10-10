import {platformHealthSchema} from '../domain/platform-health.ts';
import {ApiError,databaseError} from './http.ts';
import {authorizeWorker} from './worker-auth.ts';
export async function readPlatformHealth(request:Request,secret:string|undefined,
 load:()=>PromiseLike<{data:unknown;error:{code?:string;message?:string}|null}>) {
 authorizeWorker(request,secret);
 if(new URL(request.url).search)throw new ApiError(422,'VALIDATION_FAILED','Health queries do not accept scope or credentials.');
 const {data,error}=await load();
 if(error)databaseError(error);
 const result=platformHealthSchema.safeParse(data);
 if(!result.success)throw new ApiError(503,'HEALTH_UNAVAILABLE','Health snapshot is unavailable.');
 return result.data;
}
