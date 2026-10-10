import type {Analysis,Snapshot} from '../src/domain/analysis.ts';
export function emptyAnalysis():Analysis{return {schema_version:'analysis-1',language:'en',summary:'',intent:'UNKNOWN',budget:{min:null,max:null,currency:null,period:'UNKNOWN'},needs:{locations:[],property_type:null,bedrooms:null,timeline:null},next_step_requested:'UNKNOWN',urgency:'UNKNOWN',field_evidence:[],uncertainty:'HIGH',conflicts:[],questions:[],flags:[]};}
export const evaluationTime=Date.parse('2026-10-07T12:00:00Z');
export const fixtures=Array.from({length:100},(_,index)=>{
 const language=(['en','ar','mixed','unknown'] as const)[Math.floor(index/25)],n=index%25,budget=100000+n*15000,days=n*5+1,beds=n%6,area='Area '+index;
 const timeline=language==='ar'?`خلال ${days} أيام`:`within ${days} days`;
 const body=language==='ar'?`أريد شراء apartment في ${area} بميزانية ${budget} AED و ${beds} غرف ${timeline}. يرجى زيارة.`:language==='mixed'?`أريد شراء apartment in ${area}, budget ${budget} AED, ${beds} bedrooms ${timeline}. Please visit.`:`I want to buy apartment in ${area}, budget ${budget} AED, ${beds} bedrooms ${timeline}. Please visit.`;
 const text=beds===0?body+' studio':body;
 const id=`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`;
 const analysis:Analysis={...emptyAnalysis(),language,summary:text,intent:'BUY',budget:{min:budget,max:null,currency:'AED',period:'UNKNOWN'},needs:{locations:[area],property_type:'apartment',bedrooms:beds,timeline},next_step_requested:'VIEWING',uncertainty:'LOW'};
 analysis.field_evidence=(['intent','budget.min','budget.currency','needs.locations','needs.property_type','needs.bedrooms','needs.timeline','next_step_requested'] as const).map(field=>({field,message_id:id,message_version:1,excerpt:text}));
 const snapshot:Snapshot={confirmed:{},messages:[{id,version:1,body:text,occurred_at:'2026-10-07T12:00:00Z'}],requested_at:'2026-10-07T12:00:00Z',facts_confirmed_at:null,truncated:false};
 return {name:`${language}-${n+1}: budget ${budget}, ${beds} bedrooms, ${days} days`,analysis,snapshot,expectedScore:language==='unknown'?0:days<=30?100:days<=90?90:80};
});
