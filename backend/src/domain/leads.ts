import { z } from 'zod';

export const statuses = ['NEW','CONTACTED','QUALIFIED','FOLLOW_UP','WON','LOST'] as const;
export type Status = typeof statuses[number];
export const createLeadSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  email: z.union([z.email().max(254), z.literal('')]).default(''),
  phone: z.union([z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use an international number, e.g. +971501234567'), z.literal('')]).default(''),
  initial_message: z.string().trim().max(10000).default(''),
  budget_min: z.number().finite().nonnegative().nullable().default(null),
  budget_max: z.number().finite().nonnegative().nullable().default(null),
  currency: z.enum(['AED','USD','EUR','GBP','SAR']).nullable().default(null),
}).strict().superRefine((v, ctx) => {
  if (!v.email && !v.phone) ctx.addIssue({code:'custom',path:['email'],message:'Provide a valid email or international phone number.'});
  if (v.budget_min !== null && v.budget_max !== null && v.budget_max < v.budget_min) ctx.addIssue({code:'custom',path:['budget_max'],message:'Maximum must be at least the minimum.'});
  if ((v.budget_min !== null || v.budget_max !== null) && !v.currency) ctx.addIssue({code:'custom',path:['currency'],message:'Choose a currency for the budget.'});
});
export type CreateLead = z.infer<typeof createLeadSchema>;
const transitions: Record<Status, readonly Status[]> = {
  NEW:['CONTACTED','QUALIFIED','FOLLOW_UP','LOST'], CONTACTED:['QUALIFIED','FOLLOW_UP','WON','LOST'],
  QUALIFIED:['CONTACTED','FOLLOW_UP','WON','LOST'], FOLLOW_UP:['CONTACTED','QUALIFIED','WON','LOST'],
  WON:['CONTACTED','QUALIFIED'], LOST:['NEW','CONTACTED'],
};
export function allowedTransitions(status:Status){return transitions[status];}
export function validateTransition(from: Status, to: Status, evidence: {outbound?:boolean;qualified?:boolean;openTask?:boolean;summary?:string;reason?:string;wonAt?:string}, now = new Date()) {
  if (!transitions[from].includes(to)) return 'This status transition is not allowed.';
  if ((from==='WON'||from==='LOST') && (evidence.reason?.trim().length ?? 0)<5) return 'A reopening reason is required.';
  if (to==='CONTACTED'&&!evidence.outbound) return 'Log an outbound contact attempt first.';
  if (to==='QUALIFIED'&&!evidence.qualified) return 'Confirm intent and qualification needs first.';
  if (to==='FOLLOW_UP'&&!evidence.openTask) return 'Create an open follow up first.';
  if (to==='WON' && ((evidence.summary?.trim().length ?? 0)<5 || !evidence.wonAt || !Number.isFinite(Date.parse(evidence.wonAt)) || Date.parse(evidence.wonAt)>now.getTime())) return 'Provide an outcome summary and a valid past or current won date.';
  if (to==='LOST'&&(evidence.reason?.trim().length ?? 0)<5) return 'A loss reason is required.';
  return null;
}
export type ScoreFacts = {intent?:string;budget?:number|null;currency?:string|null;locations?:string[];propertyType?:string|null;bedrooms?:number|null;timelineDays?:number|null;nextStepRequested?:boolean};
// Input must be supported by validated source evidence or human confirmation.
export function calculateScore(facts: ScoreFacts) {
  const components = {intent:['BUY','RENT','SELL','INVEST'].includes(facts.intent ?? '')?20:0,
    budget:typeof facts.budget==='number'&&Number.isFinite(facts.budget)&&facts.budget>=0&&facts.currency?20:0,
    area:facts.locations?.some(v=>v.trim())?15:0,
    property:(facts.propertyType?.trim()?10:0)+(typeof facts.bedrooms==='number'&&Number.isInteger(facts.bedrooms)&&facts.bedrooms>=0&&facts.bedrooms<=50?5:0),
    timeline:typeof facts.timelineDays==='number'&&Number.isFinite(facts.timelineDays)&&facts.timelineDays>=0?(facts.timelineDays<=30?20:facts.timelineDays<=90?10:0):0,
    readiness:facts.nextStepRequested?10:0};
  const score=Object.values(components).reduce((a,b)=>a+b,0);
  return {score,components,rubric_version:'proposed-1',temperature:score>=80?'HOT':score>=50?'WARM':'COLD'};
}
