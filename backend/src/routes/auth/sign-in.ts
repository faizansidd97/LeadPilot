import { api,checkOrigin,readJson } from '@leadpilot/backend/server/http';
import {verifiedAuthUser} from '../../server/auth-errors.ts';
import { supabaseServer } from '@leadpilot/backend/server/supabase';
import { authSchema,validate } from '@leadpilot/backend/domain/contracts';
export async function POST(request:Request) {return api(async()=>{
 checkOrigin(request); const input=validate(authSchema,await readJson(request)); const db=await supabaseServer();
 const user=verifiedAuthUser(await db.auth.signInWithPassword(input),'sign-in');
 return {user:{id:user.id,email:user.email}};
});}
