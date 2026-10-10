import { api,checkOrigin,readJson,databaseError } from '@leadpilot/backend/server/http';
import { requireUser } from '@leadpilot/backend/server/supabase';
import { agencySchema,validate,requestKey } from '@leadpilot/backend/domain/contracts';
export async function POST(request:Request){return api(async requestId=>{
 checkOrigin(request);const {db}=await requireUser();const input=validate(agencySchema,await readJson(request));
 const {data,error}=await db.rpc('create_agency',{p_payload:input,p_key:requestKey(request),p_request_id:requestId});
 if(error)databaseError(error);return data;
},201);}
