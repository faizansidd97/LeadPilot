import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dashboardQuerySchema,defaultDashboardDates,dashboardCursorSchema,bindDashboardCursor} from '../src/domain/dashboard.ts';
import {readWorkspaceFilters,writeWorkspaceFilters} from '../src/domain/workspace-navigation.ts';
test('dashboard default is thirty agency calendar days independently of browser or UTC date',()=>{
 assert.deepEqual(defaultDashboardDates('Asia/Dubai',new Date('2026-10-01T21:00:00Z')),{from:'2026-09-03',to:'2026-10-02'});
 assert.deepEqual(defaultDashboardDates('America/New_York',new Date('2026-10-01T01:00:00Z')),{from:'2026-09-01',to:'2026-09-30'});
 assert.deepEqual(defaultDashboardDates('UTC',new Date('2024-03-01T00:00:00Z')),{from:'2024-02-01',to:'2024-03-01'});
});
test('dashboard contracts reject partial, inverted, invented, huge and malformed filters',()=>{
 for(const value of [{from:'2026-10-01'},{from:'2026-02-30',to:'2026-03-02'},{from:'2026-10-02',to:'2026-10-01'},{from:'2020-01-01',to:'2026-01-01'},{metric:'DUE'},{tenant_id:crypto.randomUUID()},{as_of:new Date().toISOString()},{from:'1969-12-31',to:'1970-01-01'},{metric:'SECRET_ADMIN'}])assert.equal(dashboardQuerySchema.safeParse(value).success,false,JSON.stringify(value));
 assert.equal(dashboardQuerySchema.safeParse({from:'2024-01-01',to:'2024-12-31'}).success,true);
 assert.equal(dashboardQuerySchema.safeParse({metric:'DUE',from:'2026-10-01',to:'2026-10-02',as_of:new Date().toISOString(),limit:'25'}).success,true);
 assert.equal(dashboardCursorSchema.safeParse({sort_at:new Date().toISOString(),id:crypto.randomUUID()}).success,false);
});
test('shareable workspace filters exclude contacts, authority, keys and arbitrary destinations',()=>{
 const read=readWorkspaceFilters('?view=Leads&status=QUALIFIED&archived=true&tenant_id=secret&q=private@example.com&token=hidden');assert.equal(read.view,'Leads');assert.equal(read.status,'QUALIFIED');assert.equal(read.archived,'true');assert.ok(!('token' in read));
 const output=writeWorkspaceFilters({...read,archived:true});assert.ok(!output.includes('private')&&!output.includes('secret')&&!output.includes('token'));
 assert.equal(readWorkspaceFilters('?view=https://attacker&status=ADMIN').view,'Dashboard');
 assert.throws(()=>writeWorkspaceFilters({view:'https://attacker'}));
});
test('a cursor cannot cross actor, agency, metric, dates or snapshot',()=>{
 const binding={tenant_id:crypto.randomUUID(),actor_id:crypto.randomUUID(),metric:'TOTAL',from:'2026-10-01',to:'2026-10-02',as_of:'2026-10-07T00:00:00Z'},cursor={...binding,sort_at:'2026-10-01T12:00:00Z',id:crypto.randomUUID()};
 assert.deepEqual(bindDashboardCursor(cursor,binding),cursor);
 for(const key of ['tenant_id','actor_id','metric','from','to','as_of'] as const)assert.throws(()=>bindDashboardCursor(cursor,{...binding,[key]:'changed'}),/INVALID_CURSOR/);
 assert.throws(()=>bindDashboardCursor({...cursor,service_role:true},binding));
});
