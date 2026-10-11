import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {localDatabase,migrationDir} from '../tests/helpers/local-db.ts';
import {buildPrivacyInventory,readLocalPrivacyCatalog,renderPrivacyInventory} from '../src/server/privacy-inventory.ts';
const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--check')||args.length>1){console.error('Use privacy-inventory.mjs with no arguments to generate, or --check to verify the saved local inventory. No remote connection mode exists.');process.exitCode=2;}
else{
 const files=(await readdir(migrationDir)).filter(name=>name.endsWith('.sql')).sort(),hash=createHash('sha256');
 for(const name of files){hash.update(name+'\0');hash.update(await readFile(new URL(name,migrationDir)));hash.update('\0');}
 const db=await localDatabase();
 try{
  const report={generated_at:new Date().toISOString(),engine:'Isolated PGlite; emulated Auth references only',node:process.version,migrations:{files,sha256:hash.digest('hex')},...buildPrivacyInventory(await readLocalPrivacyCatalog(db))};
  const destination=new URL('../../docs/PRIVACY_DATA_INVENTORY.json',import.meta.url);
  let savedMatches=true;
  if(args.includes('--check')){try{const saved=JSON.parse(await readFile(destination,'utf8'));const strip=({generated_at:_time,node:_node,...data})=>data;savedMatches=JSON.stringify(strip(saved))===JSON.stringify(strip(report))&&await readFile(new URL('../../docs/PRIVACY_DATA_INVENTORY.md',import.meta.url),'utf8')===renderPrivacyInventory(report);}catch{savedMatches=false;}}
  else{await writeFile(destination,JSON.stringify(report,null,2)+'\n');await writeFile(new URL('../../docs/PRIVACY_DATA_INVENTORY.md',import.meta.url),renderPrivacyInventory(report));}
  const pass=report.catalog_coverage_complete&&savedMatches;
  console.log(JSON.stringify({status:pass?'LOCAL_CATALOG_REVIEW_PASS':'REVIEW_REQUIRED',relations:report.coverage.relations,missing:report.coverage.missing,unclassified:report.coverage.unclassified,changed:report.coverage.changed,saved_inventory_matches:savedMatches,execution_available:false,scope:'No network, customer rows, private environment configuration or live database'}));
  if(!pass)process.exitCode=1;
 }finally{await db.close();}
}
