import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {localDatabase,seedPrivacyFixture} from './helpers/local-db.ts';
import {privacyRelationReview,type PrivacyCatalog} from '../src/domain/privacy-inventory.ts';
import {privacyReviewedSchema} from '../src/domain/privacy-inventory-baseline.ts';
import {buildPrivacyInventory,readLocalPrivacyCatalog,privacyRelationHash,renderPrivacyInventory} from '../src/server/privacy-inventory.ts';
let db:Awaited<ReturnType<typeof localDatabase>>,catalog:PrivacyCatalog;
before(async()=>{db=await localDatabase();catalog=await readLocalPrivacyCatalog(db);});after(async()=>{await db?.close();});
const copy=()=>structuredClone(catalog),get=(rows:PrivacyCatalog,name:string)=>rows.find(r=>r.name===name)!;
test('Reviewed current local schema covers every public/private relation without granting full inventory, policy or execution',()=>{
 const report=buildPrivacyInventory(catalog);assert.equal(report.coverage.tables,39);assert.equal(report.coverage.views,1);assert.equal(report.catalog_coverage_complete,true);
 assert.deepEqual(report.coverage.missing,[]);assert.deepEqual(report.coverage.unclassified,[]);assert.deepEqual(report.coverage.changed,[]);
 for(const key of ['inventory_complete','retention_policy_approved','execution_available'] as const)assert.equal(report[key],false);
 assert.equal(Object.keys(privacyRelationReview).length,40);assert.equal(Object.keys(privacyReviewedSchema).length,40);assert.ok(report.external_dependencies.every(d=>d.status==='NOT_INSPECTED'));
});
test('Inventory records composite foreign keys, cycles, key delete actions and derived scanner dependencies without a deletion order',()=>{
 const lead=get(catalog,'public.leads'),analysis=get(catalog,'public.ai_analyses'),jobs=get(catalog,'public.ai_jobs');
 assert.ok(lead.foreign_keys.some(f=>f.target==='public.ai_analyses'&&f.columns.includes('current_analysis_id')));
 assert.ok(analysis.foreign_keys.some(f=>f.target==='public.ai_jobs'));assert.ok(jobs.foreign_keys.some(f=>f.target==='public.leads'&&f.columns.length===2));
 assert.ok(get(catalog,'private.ai_context').foreign_keys.some(f=>f.target==='public.ai_jobs'));
 assert.ok(get(catalog,'private.due_candidates').dependencies.includes('public.leads'));
 assert.ok(lead.foreign_keys.every(f=>f.columns.length===f.target_columns.length));assert.ok(lead.triggers.length>0);assert.equal(lead.rls,true);assert.ok(lead.policies.length>0);
});
test('Opaque receipts/import rows, shared actor limits, aggregate usage and global key evidence remain explicitly review-dependent',()=>{
 const r=buildPrivacyInventory(catalog);assert.ok(r.relations.find(t=>t.name==='private.api_requests')!.opaque_columns.includes('response'));
 assert.ok(r.relations.find(t=>t.name==='private.lead_import_rows')!.opaque_columns.includes('payload'));
 assert.match(privacyRelationReview['private.request_limits'].scope,/Cross-tenant/);assert.match(privacyRelationReview['private.ai_usage_windows'].scope,/aggregate/);
 assert.match(privacyRelationReview['private.intake_signing_operations'].scope,/global/);assert.match(privacyRelationReview['public.memberships'].review,/independent/);
 const markdown=renderPrivacyInventory(r);assert.match(markdown,/no deletion order/);assert.match(markdown,/Function bodies|function bodies/);assert.match(markdown,/execution remain unavailable/);
});
test('New/missing relations and changed metadata fail coverage instead of silently approving or auto-updating the review baseline',()=>{
 const baseline=JSON.stringify(privacyReviewedSchema),unknown=copy();unknown.push({...structuredClone(unknown[0]),name:'private.unreviewed_table'});
 assert.deepEqual(buildPrivacyInventory(unknown).coverage.unclassified,['private.unreviewed_table']);assert.equal(buildPrivacyInventory(unknown).catalog_coverage_complete,false);
 assert.deepEqual(buildPrivacyInventory(catalog.filter(r=>r.name!=='private.ai_context')).coverage.missing,['private.ai_context']);
 for(const alter of [(r:PrivacyCatalog[number])=>r.columns.push({name:'new_payload',type:'jsonb',nullable:true}),(r:PrivacyCatalog[number])=>{r.columns[0].type='text';},(r:PrivacyCatalog[number])=>{r.rls=!r.rls;},(r:PrivacyCatalog[number])=>{r.foreign_keys[0].delete_action='c';},(r:PrivacyCatalog[number])=>{r.triggers[0].enabled='D';},(r:PrivacyCatalog[number])=>{r.policies[0].roles=['anon'];},(r:PrivacyCatalog[number])=>{r.unique_keys.pop();}]){
  const rows=copy();alter(get(rows,'public.leads'));const report=buildPrivacyInventory(rows);assert.equal(report.catalog_coverage_complete,false);assert.ok(report.coverage.changed.includes('public.leads'));
 }
 assert.equal(JSON.stringify(privacyReviewedSchema),baseline);
});
test('Malformed/duplicate relations and broken source/target column pairs never produce a trusted report',()=>{
 for(const rows of [null,[{name:'private.credentials',customer:'PRIVATE'}],catalog.concat(catalog[0]),catalog.map(r=>({...r,execution_available:true}))])assert.throws(()=>buildPrivacyInventory(rows));
 const duplicate=copy();duplicate[0].columns.push({...duplicate[0].columns[0]});assert.throws(()=>buildPrivacyInventory(duplicate));
 for(const target of ['private.nonexistent','public.leads']){const rows=copy(),r=get(rows,'public.leads');r.foreign_keys[0].target=target;r.foreign_keys[0].target_columns=['missing_column'];assert.throws(()=>buildPrivacyInventory(rows));}
 const mismatch=copy();get(mismatch,'public.leads').foreign_keys[0].columns.push('id');assert.throws(()=>buildPrivacyInventory(mismatch));
});
test('Metadata hashes are stable across isolated rebuilds and include constraints/triggers/policy/view dependencies',async()=>{
 const isolated=await localDatabase();try{const fresh=await readLocalPrivacyCatalog(isolated);assert.deepEqual(fresh,catalog);assert.equal(privacyRelationHash(fresh[0]),privacyRelationHash(catalog[0]));}finally{await isolated.close();}
 const rows=copy();get(rows,'private.due_candidates').dependencies.pop();assert.ok(buildPrivacyInventory(rows).coverage.changed.includes('private.due_candidates'));
});
test('Actual seeded private/customer rows never enter the metadata report, and reading preserves all seed business/replay/queue rows',async()=>{
 await seedPrivacyFixture(db);await db.exec('reset role');
 await db.query("update public.messages set body='PRIVATE_MESSAGE_SENTINEL'");await db.query("update private.api_requests set response=response||jsonb_build_object('hidden','PRIVATE_REPLAY_SENTINEL')");
 const state="select (select jsonb_agg(to_jsonb(l) order by id) from public.leads l) leads,(select jsonb_agg(to_jsonb(m) order by id) from public.messages m) messages,(select jsonb_agg(to_jsonb(a) order by id) from public.activity_events a) audits,(select jsonb_agg(to_jsonb(o) order by id) from private.outbox_events o) outbox,(select jsonb_agg(to_jsonb(r) order by actor_id,operation,request_key) from private.api_requests r) replay";
 const before=(await db.query(state)).rows[0],queries:string[]=[];
 const read=await readLocalPrivacyCatalog({query:async sql=>{queries.push(sql);return db.query(sql);}});
 assert.deepEqual(read,catalog);assert.deepEqual((await db.query(state)).rows[0],before);
 assert.equal(queries[0],'begin transaction isolation level repeatable read read only');assert.equal(queries.at(-1),'commit');assert.equal(queries.length,8);
 for(const sql of queries.slice(1,-1)){assert.match(sql,/pg_catalog/);assert.doesNotMatch(sql,/\bfrom\s+(?:public|private|auth)\./i);assert.doesNotMatch(sql,/pg_get_(?:functiondef|viewdef|expr)|attmissingval|adbin/i);}
 const report=JSON.stringify(buildPrivacyInventory(read));for(const marker of ['PRIVATE_MESSAGE_SENTINEL','PRIVATE_REPLAY_SENTINEL','synthetic@example.test','Foreign lead'])assert.ok(!report.includes(marker));
});
test('Actual read-only transaction rejects injected writes, rolls back and allows a later clean read',async()=>{
 let attempted=false;
 await assert.rejects(readLocalPrivacyCatalog({query:async sql=>{if(!attempted&&sql.startsWith('select')){attempted=true;return db.query("update public.messages set body='SHOULD_NOT_WRITE'");}return db.query(sql);}}),/could not be verified/);
 assert.equal((await db.query<{body:string}>('select body from public.messages limit 1')).rows[0].body,'PRIVATE_MESSAGE_SENTINEL');assert.equal(buildPrivacyInventory(await readLocalPrivacyCatalog(db)).catalog_coverage_complete,true);
});
test('Actual newly added table/column changes require review without reading added customer payloads',async()=>{
 await db.exec("create table private.unreviewed_payload(id uuid primary key,payload text);insert into private.unreviewed_payload values(gen_random_uuid(),'NEW_PRIVATE_CONTENT');alter table public.messages add column unreviewed_payload jsonb");
 try{const report=buildPrivacyInventory(await readLocalPrivacyCatalog(db));assert.equal(report.catalog_coverage_complete,false);assert.ok(report.coverage.unclassified.includes('private.unreviewed_payload'));assert.ok(report.coverage.changed.includes('public.messages'));assert.ok(!JSON.stringify(report).includes('NEW_PRIVATE_CONTENT'));assert.equal(report.execution_available,false);}
 finally{await db.exec('alter table public.messages drop column unreviewed_payload;drop table private.unreviewed_payload');}
});
test('Inventory CLI refuses remote/configuration arguments before database creation or output changes',async()=>{
 const run=promisify(execFile),cwd=fileURLToPath(new URL('../',import.meta.url));
 for(const args of [['--connect'],['--project-url=https://private.invalid'],['--check','--check']])await assert.rejects(run(process.execPath,['--experimental-strip-types','scripts/privacy-inventory.mjs',...args],{cwd,timeout:15000,windowsHide:true}),e=>{const result=e as Error&{code:number;stderr:string};assert.equal(result.code,2);assert.match(result.stderr,/No remote connection mode exists/);assert.ok(!result.stderr.includes('private.invalid'));return true;});
});
