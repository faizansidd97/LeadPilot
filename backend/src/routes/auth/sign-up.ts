import {appOrigin} from '../../server/security.ts';
import { api,checkOrigin,readJson } from '@leadpilot/backend/server/http';
import {authError} from '../../server/auth-errors.ts';
import { supabaseServer } from '@leadpilot/backend/server/supabase';
import { authSchema,validate } from '@leadpilot/backend/domain/contracts';
export async function POST(request:Request) {return api(async()=>{
 checkOrigin(request);const input=validate(authSchema,await readJson(request));const db=await supabaseServer();
 const origin=appOrigin(request.url);
 const {error}=await db.auth.signUp({...input,options:{emailRedirectTo:new URL('/auth/callback',origin).toString()}});
 if(error) throw authError(error,'sign-up');
 return {message:'Check your email to verify your account.'};
},202);}
