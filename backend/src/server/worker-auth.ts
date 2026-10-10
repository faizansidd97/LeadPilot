import {createHash,timingSafeEqual} from 'node:crypto';
import {ApiError} from './http.ts';
export function authorizeWorker(request:Request,secret:string|undefined){
 if(!secret||secret.length<32)throw new ApiError(503,'WORKER_NOT_CONFIGURED','Worker configuration is incomplete.');
 const actual=request.headers.get('authorization')??'';const expected='Bearer '+secret;
 if(!timingSafeEqual(createHash('sha256').update(actual).digest(),createHash('sha256').update(expected).digest()))throw new ApiError(401,'WORKER_UNAUTHORIZED','Worker authorization is required.');
}
