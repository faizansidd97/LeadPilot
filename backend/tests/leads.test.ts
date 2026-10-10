import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateScore, createLeadSchema, validateTransition } from '../src/domain/leads.ts';
test('rejects missing contacts, caller authority and invalid budgets',()=>{
  assert.equal(createLeadSchema.safeParse({full_name:'Buyer'}).success,false);
  assert.equal(createLeadSchema.safeParse({full_name:'Buyer',email:'buyer@example.com',tenant_id:'other'}).success,false);
  assert.equal(createLeadSchema.safeParse({full_name:'Buyer',phone:'+971501234567',budget_min:100,budget_max:10,currency:'AED'}).success,false);
  assert.equal(createLeadSchema.safeParse({full_name:'Buyer',email:'buyer@example.com',budget_min:0}).success,false);
});
test('score rubric respects timeline boundaries and unknown facts',()=>{
  assert.equal(calculateScore({}).score,0);
  for(const [days,points] of [[-1,0],[0,20],[30,20],[31,10],[90,10],[91,0]]) assert.equal(calculateScore({timelineDays:days}).components.timeline,points);
  assert.equal(calculateScore({intent:'BUY',budget:0,currency:'AED',locations:['Dubai Marina'],propertyType:'APARTMENT',bedrooms:0,timelineDays:30,nextStepRequested:true}).score,100);
});
test('lifecycle requires contact, tasks and outcome evidence',()=>{
  assert.ok(validateTransition('NEW','CONTACTED',{}));
  assert.ok(validateTransition('NEW','FOLLOW_UP',{}));
  assert.ok(validateTransition('NEW','WON',{}));
  assert.equal(validateTransition('NEW','CONTACTED',{outbound:true}),null);
  assert.ok(validateTransition('CONTACTED','WON',{summary:'Deal complete',wonAt:'invalid'}));
  assert.ok(validateTransition('LOST','NEW',{}));
});

