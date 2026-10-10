import { api,checkOrigin } from '@leadpilot/backend/server/http';
import {authError} from '../../server/auth-errors.ts';
import { supabaseServer } from '@leadpilot/backend/server/supabase';
export async function POST(request:Request){return api(async()=>{checkOrigin(request);const db=await supabaseServer();const {error}=await db.auth.signOut();if(error)throw authError(error,'sign-out');return {signed_out:true};});}
