import { api,databaseError } from '@leadpilot/backend/server/http';
import { requireUser } from '@leadpilot/backend/server/supabase';
export async function GET(){return api(async()=>{
 const {db,user}=await requireUser();const {data,error}=await db.from('memberships').select('id,tenant_id,role,agencies(id,name,timezone,locale)').eq('user_id',user.id).eq('active',true);
 if(error)databaseError(error);return {user:{id:user.id,email:user.email},memberships:data};
});}
