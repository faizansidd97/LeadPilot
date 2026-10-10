import type {SupabaseClient} from '@supabase/supabase-js';
import {refreshAnalysisScore,type AnalysisResult} from '../domain/analysis.ts';
import {databaseError} from './http.ts';
export async function attachCurrentScores(db:SupabaseClient,tenantId:string,leads:Record<string,unknown>[]){
 const ids=leads.map(l=>l.current_analysis_id).filter((id):id is string=>typeof id==='string');if(!ids.length)return leads;
 const {data,error}=await db.from('ai_analyses').select('id,lead_id,input_version,freshness,result').eq('tenant_id',tenantId).in('id',ids);if(error)databaseError(error);
 for(const lead of leads){const saved=data!.find(a=>a.id===lead.current_analysis_id&&a.lead_id===lead.id&&a.input_version===lead.context_version&&a.freshness==='CURRENT');if(saved){const projected=refreshAnalysisScore(saved.result as AnalysisResult);lead.current_analysis={id:saved.id,score:projected.score,temperature:projected.temperature,rubric_version:projected.rubric_version,score_as_of:projected.score_as_of};}}
 return leads;
}
