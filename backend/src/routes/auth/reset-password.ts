import {appOrigin} from '../../server/security.ts';
import { api,checkOrigin,readJson } from '@leadpilot/backend/server/http';
import {authError} from '../../server/auth-errors.ts';
import { supabaseServer } from '@leadpilot/backend/server/supabase';
import { resetSchema,validate } from '@leadpilot/backend/domain/contracts';
export async function POST(request:Request){return api(async()=>{
 checkOrigin(request);const input=validate(resetSchema,await readJson(request));const db=await supabaseServer();
 const origin=appOrigin(request.url);
 const {error}=await db.auth.resetPasswordForEmail(input.email,{redirectTo:new URL('/auth/callback?next=/reset-password',origin).toString()});
 if(error)throw authError(error,'reset-password');
 return {message:'If an account exists, a password reset email will be sent.'};
},202);}
