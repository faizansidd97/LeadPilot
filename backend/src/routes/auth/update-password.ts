import { z } from 'zod';
import { api,checkOrigin,readJson } from '@leadpilot/backend/server/http';
import {authError} from '../../server/auth-errors.ts';
import { requireUser } from '@leadpilot/backend/server/supabase';
import { validate } from '@leadpilot/backend/domain/contracts';
export async function POST(request:Request){return api(async()=>{
 checkOrigin(request);const {db}=await requireUser('mutation');const input=validate(z.object({password:z.string().min(8).max(128)}).strict(),await readJson(request));
 const {error}=await db.auth.updateUser(input);if(error)throw authError(error,'update-password');
 return {updated:true};
});}
