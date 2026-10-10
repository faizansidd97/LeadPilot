import {appOrigin} from '../../server/security.ts';
import { NextResponse } from 'next/server';
import { supabaseServer } from '@leadpilot/backend/server/supabase';
export async function GET(request:Request){
 const url=new URL(request.url);const code=url.searchParams.get('code');
 let origin:string;try{origin=appOrigin(request.url);}catch{return NextResponse.json({error:{code:'APP_NOT_CONFIGURED',message:'Application origin configuration is unavailable.'}},{status:503,headers:{'Cache-Control':'private, no-store'}});}const next=url.searchParams.get('next')==='/reset-password'?'/reset-password':'/';
 if(code){try{const db=await supabaseServer();const {error}=await db.auth.exchangeCodeForSession(code);if(!error)return NextResponse.redirect(new URL(next,origin),{headers:{'Cache-Control':'no-store'}});}catch{}}
 return NextResponse.redirect(new URL('/?auth_error=verification',origin),{headers:{'Cache-Control':'no-store'}});
}
