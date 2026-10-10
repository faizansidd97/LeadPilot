import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { ApiError, databaseError } from './http';
import {authorizeVerifiedUser} from './auth-errors.ts';
export function configured() { return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY); }
export async function supabaseServer() {
  if (!configured()) throw new ApiError(503,'BACKEND_NOT_CONFIGURED','Configure Supabase URL and publishable key before using the backend.');
  const jar = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: { getAll:()=>jar.getAll(), setAll:updates=>{ for (const {name,value,options} of updates) jar.set(name,value,options); } },
  });
}
export async function requireUser(kind:'read'|'mutation'='read') {
  const db=await supabaseServer();
  const user=await authorizeVerifiedUser(()=>db.auth.getUser(),async()=>{
    const gate=await db.rpc('consume_http_limit',{p_kind:kind});if(gate.error)databaseError(gate.error);
    if(!gate.data.allowed){const limited=new ApiError(429,'RATE_LIMITED','Too many requests. Wait a moment and retry.');limited.retryAfter=gate.data.retry_after;throw limited;}
  });
  return {db,user};
}
export async function requireTenant(request:Request) {
  const {db,user}=await requireUser(request.method==='GET'||request.method==='HEAD'?'read':'mutation');
  const tenantId=request.headers.get('x-tenant-id');
  if (!tenantId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) throw new ApiError(422,'TENANT_REQUIRED','Select an agency.');
  const {data,error}=await db.from('memberships').select('id,role,tenant_id').eq('tenant_id',tenantId).eq('user_id',user.id).eq('active',true).maybeSingle();
  if (error) databaseError(error);
  if (!data) throw new ApiError(403,'MEMBERSHIP_REQUIRED','Active agency membership is required.');
  return {db,user,tenantId,membership:data};
}
