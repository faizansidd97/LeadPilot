import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
export const workspace=new URL('../../',import.meta.url);
export async function fingerprint(){
 const paths=[];
 async function walk(relative){for(const entry of await readdir(new URL(relative+'/',workspace),{withFileTypes:true})){const next=relative+'/'+entry.name;if(entry.isDirectory())await walk(next);else paths.push(next);}}
 for(const relative of ['backend/src','backend/tests','backend/scripts','backend/supabase/migrations','frontend/src'])await walk(relative);
 paths.push('backend/package.json','backend/tsconfig.json','backend/supabase/setup.sql','frontend/package.json','frontend/tsconfig.json','frontend/next.config.ts','frontend/postcss.config.mjs','frontend/pnpm-lock.yaml');
 const hash=createHash('sha256');for(const relative of paths.sort()){hash.update(relative+'\0');hash.update(await readFile(new URL(relative,workspace)));hash.update('\0');}return {sha256:hash.digest('hex'),files:paths.length};
}
export function parseEnv(source){return Object.fromEntries(source.split(/\r?\n/).flatMap(line=>{const match=line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);if(!match)return [];let value=match[2];if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);else value=value.replace(/\s+#.*$/,'').trim();return [[match[1],value]];}));}
