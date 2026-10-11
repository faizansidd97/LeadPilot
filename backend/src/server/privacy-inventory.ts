import {createHash} from 'node:crypto';
import {privacyCatalogSchema,privacyRelationReview,privacyExternalInventory,type PrivacyCatalog} from '../domain/privacy-inventory.ts';
import {privacyReviewedSchema} from '../domain/privacy-inventory-baseline.ts';
type Reader={query:(sql:string)=>Promise<{rows:unknown[]}>};
// Local development tool only. No row payload/default/SQL function-body/credential query.
const catalogQueries=[
 `select n.nspname||'.'||c.relname name,c.relkind kind,c.relrowsecurity rls,c.relforcerowsecurity forced_rls,
 jsonb_agg(jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'nullable',not a.attnotnull) order by a.attnum) columns
 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
 where n.nspname in ('public','private') and c.relkind in ('r','p','v','m') group by n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity order by 1`,
 `select ns.nspname||'.'||src.relname source,f.conname name,
 array(select a.attname from unnest(f.conkey) with ordinality k(num,ord) join pg_catalog.pg_attribute a on a.attrelid=f.conrelid and a.attnum=k.num order by k.ord) columns,
 nt.nspname||'.'||dst.relname target,array(select a.attname from unnest(f.confkey) with ordinality k(num,ord) join pg_catalog.pg_attribute a on a.attrelid=f.confrelid and a.attnum=k.num order by k.ord) target_columns,
 f.confdeltype delete_action,f.condeferrable deferrable,f.condeferred initially_deferred from pg_catalog.pg_constraint f
 join pg_catalog.pg_class src on src.oid=f.conrelid join pg_catalog.pg_namespace ns on ns.oid=src.relnamespace
 join pg_catalog.pg_class dst on dst.oid=f.confrelid join pg_catalog.pg_namespace nt on nt.oid=dst.relnamespace where ns.nspname in ('public','private') and f.contype='f' order by 1,2`,
 `select ns.nspname||'.'||src.relname source,f.conname name,f.contype kind,
 array(select a.attname from unnest(f.conkey) with ordinality k(num,ord) join pg_catalog.pg_attribute a on a.attrelid=f.conrelid and a.attnum=k.num order by k.ord) columns
 from pg_catalog.pg_constraint f join pg_catalog.pg_class src on src.oid=f.conrelid join pg_catalog.pg_namespace ns on ns.oid=src.relnamespace where ns.nspname in ('public','private') and f.contype in ('p','u') order by 1,2`,
 `select ns.nspname||'.'||src.relname source,t.tgname name,nf.nspname function_schema,p.proname function_name,t.tgenabled enabled from pg_catalog.pg_trigger t
 join pg_catalog.pg_class src on src.oid=t.tgrelid join pg_catalog.pg_namespace ns on ns.oid=src.relnamespace join pg_catalog.pg_proc p on p.oid=t.tgfoid join pg_catalog.pg_namespace nf on nf.oid=p.pronamespace
 where ns.nspname in ('public','private') and not t.tgisinternal order by 1,2`,
 `select distinct ns.nspname||'.'||src.relname source,nt.nspname||'.'||dst.relname target from pg_catalog.pg_rewrite rw join pg_catalog.pg_class src on src.oid=rw.ev_class join pg_catalog.pg_namespace ns on ns.oid=src.relnamespace
 join pg_catalog.pg_depend d on d.objid=rw.oid and d.classid='pg_catalog.pg_rewrite'::regclass and d.refclassid='pg_catalog.pg_class'::regclass join pg_catalog.pg_class dst on dst.oid=d.refobjid join pg_catalog.pg_namespace nt on nt.oid=dst.relnamespace
 where ns.nspname in ('public','private') and src.relkind in ('v','m') and nt.nspname in ('public','private','auth') and dst.oid<>src.oid order by 1,2`,
 `select schemaname||'.'||tablename source,policyname name,cmd command,permissive,array(select unnest(roles)::text order by 1) roles from pg_catalog.pg_policies where schemaname in ('public','private') order by 1,2`
];
export async function readLocalPrivacyCatalog(db:Reader):Promise<PrivacyCatalog>{
 await db.query('begin transaction isolation level repeatable read read only');
 try{
  const rows=[];for(const sql of catalogQueries)rows.push((await db.query(sql)).rows as Record<string,unknown>[]);
  const [relations,foreign,unique,triggers,dependencies,policies]=rows;
  const nested=(source:unknown,list:Record<string,unknown>[])=>list.filter(r=>r.source===source).map(({source:_source,...fields})=>fields);
  const catalog=privacyCatalogSchema.parse(relations.map(r=>({...r,foreign_keys:nested(r.name,foreign),unique_keys:nested(r.name,unique),triggers:nested(r.name,triggers),dependencies:dependencies.filter(d=>d.source===r.name).map(d=>d.target),policies:nested(r.name,policies)})));
  assertCatalog(catalog);await db.query('commit');return catalog;
 }catch{await db.query('rollback');throw Error('The local privacy schema inventory could not be verified.');}
}
function assertCatalog(catalog:PrivacyCatalog){
 const names=new Set(catalog.map(r=>r.name));if(names.size!==catalog.length)throw Error('Duplicate relations.');
 for(const r of catalog){const cols=new Set(r.columns.map(c=>c.name));if(cols.size!==r.columns.length)throw Error('Duplicate columns.');
  for(const key of [...r.foreign_keys,...r.unique_keys])if(key.columns.some(c=>!cols.has(c)))throw Error('Unknown source column.');
  for(const fk of r.foreign_keys){if(fk.columns.length!==fk.target_columns.length)throw Error('Unpaired foreign key.');if(fk.target.startsWith('auth.'))continue;const target=catalog.find(t=>t.name===fk.target);if(!target||fk.target_columns.some(c=>!target.columns.some(tc=>tc.name===c)))throw Error('Unknown target.');}
  for(const target of r.dependencies)if(!target.startsWith('auth.')&&!names.has(target))throw Error('Unknown view dependency.');
 }
}
export const privacyRelationHash=(relation:PrivacyCatalog[number])=>createHash('sha256').update(JSON.stringify(relation)).digest('hex');
export function buildPrivacyInventory(value:unknown){
 const catalog=privacyCatalogSchema.parse(value);assertCatalog(catalog);
 const missing=Object.keys(privacyRelationReview).filter(name=>!catalog.some(r=>r.name===name)).sort(),unclassified=catalog.filter(r=>!privacyRelationReview[r.name]).map(r=>r.name),changed=catalog.filter(r=>privacyRelationReview[r.name]&&privacyReviewedSchema[r.name]!==privacyRelationHash(r)).map(r=>r.name);
 const complete=!missing.length&&!unclassified.length&&!changed.length;
 return {format_version:1,scope:'LOCAL_SCHEMA_METADATA_ONLY',catalog_coverage_complete:complete,inventory_complete:false,retention_policy_approved:false,execution_available:false,
  coverage:{relations:catalog.length,tables:catalog.filter(r=>['r','p'].includes(r.kind)).length,views:catalog.filter(r=>['v','m'].includes(r.kind)).length,missing,unclassified,changed},
  external_dependencies:privacyExternalInventory.map(description=>({description,status:'NOT_INSPECTED'})),
  relations:catalog.map(r=>({...r,review:privacyRelationReview[r.name]??{category:'Unclassified',scope:'Unknown',review:'Review this relation before any deletion design.'},schema_sha256:privacyRelationHash(r),opaque_columns:r.columns.filter(c=>['json','jsonb'].includes(c.type)).map(c=>c.name)}))};
}
export function renderPrivacyInventory(report:ReturnType<typeof buildPrivacyInventory>){
 const rows=report.relations.map(r=>`| ${r.name} | ${r.kind==='v'?'View':'Table'} | ${r.review.category} | ${r.review.scope} | ${r.foreign_keys.length} | ${r.opaque_columns.join(', ')||'None'} |`).join('\n');
 return `# Local privacy schema inventory\n\nCatalog coverage: ${report.catalog_coverage_complete?'COMPLETE for the reviewed local public/private schema':'REVIEW_REQUIRED'}. ${report.coverage.tables} tables and ${report.coverage.views} views. This is catalog metadata only; full data inventory, approved retention and deletion execution remain unavailable. No record values or live credentials are read.\n\n| Relation | Kind | Record class | Scope to review | Foreign keys | Opaque fields |\n| --- | --- | --- | --- | ---: | --- |\n${rows}\n\n## Review before execution\n\n${report.relations.map(r=>`- ${r.name}: ${r.review.review}`).join('\n')}\n\nThe JSON companion records every column/type/nullability, declared foreign-key delete action, primary/unique constraint, trigger identity, RLS policy name/roles/command and direct view dependency. It does not classify SQL function bodies or inspect defaults, index expressions, provider schemas, row values or deployment-specific extensions. Foreign-key graph cycles and absent/opaque lead references require a reviewed plan; no deletion order, auto-cascade or safe key retirement is inferred. New/missing relations or reviewed metadata changes fail the coverage check.\n\n## External inventory still pending\n\n${report.external_dependencies.map(e=>`- ${e.description}: ${e.status}`).join('\n')}\n\nSee PRIVACY_POLICY_REQUIREMENTS.md and PRIVACY_IMPACT.md. The existing case impact preview remains partial; this developer tool neither enables that UI nor grants execution authority.\n`;
}
