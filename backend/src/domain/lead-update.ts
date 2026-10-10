import { z } from 'zod';
import { createLeadSchema } from './leads.ts';
export const updateLeadSchema=z.object({
 full_name:createLeadSchema.shape.full_name,email:createLeadSchema.shape.email,phone:createLeadSchema.shape.phone,
 budget_min:createLeadSchema.shape.budget_min,budget_max:createLeadSchema.shape.budget_max,currency:createLeadSchema.shape.currency,
 expected_version:z.number().int().positive(),
}).strict().superRefine((value,context)=>{
 const {expected_version,...fields}=value;const checked=createLeadSchema.safeParse(fields);
 if(!checked.success)for(const issue of checked.error.issues)context.addIssue({code:"custom",path:issue.path,message:issue.message});
});

