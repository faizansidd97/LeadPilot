import {z} from 'zod';
import {calculateScore} from './leads.ts';
export const PROMPT_VERSION='analysis-1',SCHEMA_VERSION='analysis-1',RUBRIC_VERSION='proposed-1';
const currency=z.enum(['AED','USD','EUR','GBP','SAR']).nullable();
export const evidenceFields=['intent','budget.min','budget.max','budget.currency','budget.period','needs.locations','needs.property_type','needs.bedrooms','needs.timeline','next_step_requested','urgency'] as const;
export const analysisSchema=z.object({
 schema_version:z.literal(SCHEMA_VERSION),language:z.enum(['en','ar','mixed','unknown']),summary:z.string().max(1000),
 intent:z.enum(['BUY','RENT','SELL','INVEST','OTHER','UNKNOWN']),
 budget:z.object({min:z.number().finite().nonnegative().nullable(),max:z.number().finite().nonnegative().nullable(),currency,period:z.enum(['MONTH','YEAR','TOTAL','UNKNOWN'])}).strict(),
 needs:z.object({locations:z.array(z.string().min(1).max(120)).max(5),property_type:z.string().min(1).max(120).nullable(),bedrooms:z.number().int().min(0).max(50).nullable(),timeline:z.string().min(1).max(500).nullable()}).strict(),
 next_step_requested:z.enum(['VIEWING','CALLBACK','OTHER','NONE','UNKNOWN']),urgency:z.enum(['HIGH','MEDIUM','LOW','UNKNOWN']),
 field_evidence:z.array(z.object({field:z.enum(evidenceFields),message_id:z.uuid(),message_version:z.number().int().positive(),excerpt:z.string().min(1).max(240)}).strict()).max(40),
 uncertainty:z.enum(['LOW','MEDIUM','HIGH']),conflicts:z.array(z.object({field:z.enum(evidenceFields),message_ids:z.array(z.uuid()).min(2).max(5)}).strict()).max(12),
 questions:z.array(z.string().min(1).max(240)).max(10),flags:z.array(z.enum(['MISSING_DATA','CONFLICTING_FACTS','TRUNCATED','UNSAFE_INSTRUCTION','UNSUPPORTED_LANGUAGE','EXPIRED_TIMELINE','UNKNOWN_CURRENCY'])).max(7),
}).strict().superRefine((v,c)=>{if(v.budget.min!==null&&v.budget.max!==null&&v.budget.min>v.budget.max)c.addIssue({code:'custom',path:['budget'],message:'Invalid range.'});});
export type Analysis=z.infer<typeof analysisSchema>;
export type Snapshot={confirmed:Record<string,unknown>;messages:{id:string;version:number;body:string;occurred_at:string}[];truncated:boolean;requested_at:string;facts_confirmed_at:string|null};
export const submitAnalysisSchema=z.object({expected_version:z.number().int().positive()}).strict();
export class AnalysisFailure extends Error{code:string;transient:boolean;tokens:number|null;constructor(code:string,transient=false,tokens:number|null=null){super(code);this.code=code;this.transient=transient;this.tokens=tokens;}}
const normalized=(s:string)=>s.toLowerCase().replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));
const actionPatterns:Record<string,RegExp>={BUY:/\b(buy|purchase)\b|شراء|اشتري/,RENT:/\b(rent|lease)\b|إيجار|ايجار|استئجار/,SELL:/\bsell\b|بيع/,INVEST:/\binvest\w*\b|استثمار/,OTHER:/\b(other|enquiry)\b|استفسار/,
 VIEWING:/\b(viewing|view|visit)\b|معاينة|زيارة/,CALLBACK:/\b(call|callback)\b|اتصل|اتصال/,NONE:/\b(no|not)\b|لا/,HIGH:/\b(urgent|immediate|asap)\b|عاجل|فورا/,MEDIUM:/\b(soon|week)\b|قريب|أسبوع/,LOW:/\b(no rush|later|flexible)\b|لاحق|غير مستعجل/};
export function timelineTarget(text:string,anchor:string|null){
 const source=normalized(text),date=source.match(/\b(\d{4}-\d{2}-\d{2})\b/);if(date){const stamp=Date.parse(date[1]+'T00:00:00Z');return Number.isFinite(stamp)&&new Date(stamp).toISOString().startsWith(date[1])?stamp:null;}
 if(!anchor||!Number.isFinite(Date.parse(anchor)))return null;
 const m=source.match(/(?:within|in|خلال)\s+(\d{1,3})\s*(days?|weeks?|months?|يوم|أيام|ايام|أسبوع|أسابيع|اسابيع|شهر|أشهر|اشهر)/);if(m){const n=Number(m[1]),unit=m[2];return Date.parse(anchor)+n*(/week|أسبوع|أسابيع|اسابيع/.test(unit)?7:/month|شهر|أشهر|اشهر/.test(unit)?30:1)*86400000;}
 if(/\b(today|tomorrow)\b|اليوم|غدا/.test(source))return Date.parse(anchor)+(/tomorrow|غدا/.test(source)?86400000:0);return null;
}
function hasNumber(text:string,value:number){const s=normalized(text);const numbers=[...s.matchAll(/\d[\d,]*(?:\.\d+)?\s*(million|thousand|m\b|k\b|مليون|ألف|الف)?/g)].map(m=>Number(m[0].replace(/,/g,'').match(/^[\d.]+/)![0])*(/million|^m$|مليون/.test(m[1]??'')?1e6:/thousand|^k$|ألف|الف/.test(m[1]??'')?1000:1));return numbers.includes(value);}
export function validateAnalysis(input:unknown,snapshot:Snapshot,approvedLanguages:string[],now=Date.now()){
 const parsed=analysisSchema.safeParse(input);if(!parsed.success)throw new AnalysisFailure('INVALID_SCHEMA');const a=parsed.data;
 const source=new Map(snapshot.messages.map(m=>[m.id,m]));
 for(const e of a.field_evidence){const m=source.get(e.message_id);if(!m||m.version!==e.message_version||!m.body.includes(e.excerpt)||/ignore previous|ignore all|reveal.*secret|تجاهل التعليمات/i.test(e.excerpt))throw new AnalysisFailure('INVALID_EVIDENCE');}
 for(const c of a.conflicts)if(c.message_ids.some(id=>!source.has(id))||new Set(c.message_ids).size<2||c.message_ids.some(id=>!a.field_evidence.some(e=>e.field===c.field&&e.message_id===id)))throw new AnalysisFailure('INVALID_EVIDENCE');
 if(a.summary&&!snapshot.messages.some(m=>m.body.includes(a.summary)))throw new AnalysisFailure('UNSUPPORTED_SUMMARY');
 if(/guaranteed (?:returns?|approval|profit|income)|ignore previous|ignore all|reveal.*secret|مضمون|تجاهل التعليمات/i.test([a.summary,...a.questions].join(' ')))throw new AnalysisFailure('UNSAFE_OUTPUT');
 const cited=(field:string,value:unknown,test?:(s:string)=>boolean)=>{if(value==null||value==='UNKNOWN'||value==='NONE'||Array.isArray(value)&&!value.length)return;const evidence=a.field_evidence.filter(e=>e.field===field);if(!evidence.length||test&&!evidence.some(e=>test(normalized(e.excerpt))))throw new AnalysisFailure('INVALID_EVIDENCE');};
 cited('intent',a.intent,s=>(actionPatterns[a.intent]?.test(s)??false)&&!/(?:not|don't|do not|never|no longer)\s+(?:want to\s+|looking to\s+)?(?:buy|purchase|rent|lease|sell|invest)|لا\s+(?:أريد\s+|اريد\s+)?(?:شراء|استئجار|بيع)/.test(s));
 for(const key of ['min','max'] as const)cited('budget.'+key,a.budget[key],s=>hasNumber(s,a.budget[key]!)&&/budget|price|aed|usd|eur|gbp|sar|ميزانية|سعر/.test(s));
 cited('budget.currency',a.budget.currency,s=>s.includes(a.budget.currency!.toLowerCase()));
 if((a.budget.min!==null||a.budget.max!==null)&&!a.budget.currency)throw new AnalysisFailure('UNKNOWN_CURRENCY');
 cited('budget.period',a.budget.period,s=>({MONTH:/month|شهري|شهر/,YEAR:/year|annual|سنوي|سنة/,TOTAL:/total|إجمالي|اجمالي/}[a.budget.period as 'MONTH'|'YEAR'|'TOTAL'])?.test(s)??false);
 for(const location of a.needs.locations)cited('needs.locations',location,s=>s.includes(normalized(location)));
 cited('needs.property_type',a.needs.property_type,s=>s.includes(normalized(a.needs.property_type!)));
 cited('needs.bedrooms',a.needs.bedrooms,s=>a.needs.bedrooms===0?/studio|استوديو/.test(s):new RegExp(`(?:\\b${a.needs.bedrooms}\\s*(?:bedrooms?|beds?|br\\b)|${a.needs.bedrooms}\\s*غرف|غرف(?:ة)?\\s*${a.needs.bedrooms}\\b)`).test(s));
 cited('needs.timeline',a.needs.timeline,s=>s.includes(normalized(a.needs.timeline!)));
 cited('next_step_requested',a.next_step_requested,s=>a.next_step_requested==='OTHER'?/request|please|يرجى|أريد/.test(s):actionPatterns[a.next_step_requested]?.test(s)??false);
 cited('urgency',a.urgency,s=>actionPatterns[a.urgency]?.test(s)??false);
 const flags=new Set(a.flags);if(a.intent==='UNKNOWN'||a.budget.min===null&&a.budget.max===null||!a.budget.currency||!a.needs.locations.length||a.needs.property_type===null||a.needs.bedrooms===null||a.needs.timeline===null)flags.add('MISSING_DATA');if(snapshot.truncated)flags.add('TRUNCATED');if(a.conflicts.length)flags.add('CONFLICTING_FACTS');if(!approvedLanguages.includes(a.language))flags.add('UNSUPPORTED_LANGUAGE');
 if(snapshot.messages.some(m=>/ignore previous|ignore all|reveal.*secret|تجاهل التعليمات/i.test(m.body)))flags.add('UNSAFE_INSTRUCTION');
 const facts=snapshot.confirmed;const conflicts=new Set<string>(a.conflicts.map(c=>c.field));const supported=(field:string,value:unknown)=>conflicts.has(field)?undefined:value;
 const intent=facts.confirmed_intent??supported('intent',a.intent),budget=facts.budget_min??facts.budget_max??supported('budget.min',a.budget.min)??supported('budget.max',a.budget.max),money=facts.currency??supported('budget.currency',a.budget.currency);
 const humanTimeline=typeof facts.purchase_timeline==='string'&&facts.purchase_timeline.trim()?facts.purchase_timeline:null;
 const timedEvidence=a.field_evidence.filter(e=>e.field==='needs.timeline');const latest=timedEvidence.sort((x,y)=>Date.parse(source.get(y.message_id)!.occurred_at)-Date.parse(source.get(x.message_id)!.occurred_at))[0];
 const target=humanTimeline?timelineTarget(humanTimeline,snapshot.facts_confirmed_at):!conflicts.has('needs.timeline')&&a.needs.timeline?timelineTarget(a.needs.timeline,latest?source.get(latest.message_id)!.occurred_at:null):null;
 const timelineDays=target===null||target<now?null:Math.ceil((target-now)/86400000);if(target!==null&&target<now)flags.add('EXPIRED_TIMELINE');
 const hasHuman=(k:string)=>Object.hasOwn(facts,k)&&facts[k]!==null&&facts[k]!=='';
 const scored=calculateScore({intent:typeof intent==='string'?intent:undefined,budget:typeof budget==='number'?budget:null,currency:typeof money==='string'?money:null,
 locations:Array.isArray(facts.locations)&&facts.locations.length?facts.locations as string[]:supported('needs.locations',a.needs.locations) as string[]|undefined,
 propertyType:hasHuman('property_type')?facts.property_type as string:supported('needs.property_type',a.needs.property_type) as string|null,
 bedrooms:hasHuman('bedrooms')?facts.bedrooms as number:supported('needs.bedrooms',a.needs.bedrooms) as number|null,timelineDays,
 nextStepRequested:!conflicts.has('next_step_requested')&&['VIEWING','CALLBACK','OTHER'].includes(a.next_step_requested)});
 if(flags.has('UNSUPPORTED_LANGUAGE')){scored.score=0;scored.temperature='COLD';for(const k of Object.keys(scored.components) as (keyof typeof scored.components)[])scored.components[k]=0;}
 return {analysis:{...a,flags:[...flags]},...scored,timeline_target_at:target===null?null:new Date(target).toISOString(),scored_at:new Date(now).toISOString()};
}
export type AnalysisResult=ReturnType<typeof validateAnalysis>;
export function refreshAnalysisScore(result:AnalysisResult,now=Date.now()){
 const value=structuredClone(result),target=value.timeline_target_at?Date.parse(value.timeline_target_at):NaN,days=(target-now)/86400000;
 value.components.timeline=!value.analysis.flags.includes('UNSUPPORTED_LANGUAGE')&&Number.isFinite(target)&&days>=0?(days<=30?20:days<=90?10:0):0;
 if(Number.isFinite(target)&&days<0&&!value.analysis.flags.includes('EXPIRED_TIMELINE'))value.analysis.flags.push('EXPIRED_TIMELINE');
 value.score=Object.values(value.components).reduce((sum,n)=>sum+n,0);value.temperature=value.score>=80?'HOT':value.score>=50?'WARM':'COLD';
 return {...value,score_as_of:new Date(now).toISOString()};
}
// JSON Schema comes from the same strict Zod fields; cross-field evidence is validated after parsing.
export const analysisJsonSchema=z.toJSONSchema(analysisSchema,{target:'draft-7'});
