import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stagingConfiguration, stagingTables, verifyStaging} from '../src/server/staging-verification.ts';
import {localDatabase} from './helpers/local-db.ts';

const env = {NEXT_PUBLIC_SUPABASE_URL:'https://staging.example.test', NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_fixture'};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
const auth = {external:{email:true},mailer_autoconfirm:false,disable_signup:false};
const denial = () => json({code:'42501',message:'PRIVATE_REMOTE_DIAGNOSTIC'},403);
const fake = (settings: unknown = auth) => (async (input) =>
  new URL(String(input)).pathname === '/auth/v1/settings' ? json(settings) : denial()) as typeof fetch;

test('staging baseline uses bounded GET public-key probes and explicit incomplete acceptance', async () => {
  const calls: string[] = [];
  const report = await verifyStaging({...env,SUPABASE_SERVICE_ROLE_KEY:'PRIVATE_SERVICE_SECRET'}, async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    assert.equal(url.origin,env.NEXT_PUBLIC_SUPABASE_URL);
    assert.equal(init?.method,'GET'); assert.equal(init?.redirect,'error'); assert.equal(init?.cache,'no-store');
    assert.ok(init?.signal); assert.equal(new Headers(init?.headers).get('apikey'),env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
    assert.equal(new Headers(init?.headers).get('authorization'),null);
    if (url.pathname.startsWith('/rest/')) {
      assert.equal(url.searchParams.get('select'),'id'); assert.equal(url.searchParams.get('limit'),'0');
      assert.equal(new Headers(init?.headers).get('Accept-Profile'),'public');
      return denial();
    }
    return json(auth);
  });
  assert.equal(report.status,'BASELINE_PASS'); assert.equal(calls.length,16);
  assert.deepEqual(calls.slice(1),stagingTables.map(table => '/rest/v1/'+table));
  for (const field of ['authenticated_acceptance','migration_revision_verified','worker_verified','browser_accepted','release_accepted'] as const) assert.equal(report[field],false);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE|sb_publishable|example.test/);
});

test('invalid and privileged configuration fails before any transport', async t => {
  const jwt = (role: string) => 'eyJ0eXAiOiJKV1QifQ.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.signature';
  assert.equal(stagingConfiguration({...env,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:jwt('anon')}).key,jwt('anon'));
  for (const [name, values] of [
    ['empty URL',{NEXT_PUBLIC_SUPABASE_URL:''}],['HTTP',{NEXT_PUBLIC_SUPABASE_URL:'http://staging.example.test'}],
    ['credentials',{NEXT_PUBLIC_SUPABASE_URL:'https://user:secret@staging.example.test'}],
    ['path',{NEXT_PUBLIC_SUPABASE_URL:'https://staging.example.test/extra'}],
    ['query',{NEXT_PUBLIC_SUPABASE_URL:'https://staging.example.test/?key=secret'}],
    ['fragment',{NEXT_PUBLIC_SUPABASE_URL:'https://staging.example.test/#secret'}],
    ['localhost',{NEXT_PUBLIC_SUPABASE_URL:'https://localhost'}],
    ['empty key',{NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:''}],
    ['service key',{NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_secret_private'}],
    ['service JWT',{NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:jwt('service_role')}],
    ['authenticated JWT',{NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:jwt('authenticated')}],
  ] as const) await t.test(name, async () => {
    let calls = 0;
    await assert.rejects(verifyStaging({...env,...values},async () => {calls++; return denial();}),/INVALID_STAGING_CONFIGURATION/);
    assert.equal(calls,0);
  });
});

test('email settings fail closed for disabled provider, autoconfirm, disabled signup and missing/ill-typed fields', async () => {
  for (const settings of [null,{}, {...auth,external:{email:false}}, {...auth,mailer_autoconfirm:true},
    {...auth,disable_signup:true}, {...auth,mailer_autoconfirm:'false'}]) {
    const report = await verifyStaging(env,fake(settings));
    assert.equal(report.status,'BASELINE_FAIL'); assert.equal(report.checks[0].status,'FAIL');
  }
});

test('open table including empty 200, missing table and wrong denial code cannot pass', async () => {
  for (const [status, body] of [[200,[]],[404,{code:'PGRST205'}],[401,{code:'PGRST301'}],[401,{code:'PGRST302'}],[401,{}],[403,{code:'OTHER'}],[500,{code:'42501'}]] as const) {
    const report = await verifyStaging(env,async (input) => new URL(String(input)).pathname.endsWith('/privacy_case_actions')
      ? json(body,status) : fake()(input));
    assert.equal(report.status,'BASELINE_FAIL'); assert.equal(report.checks.at(-1)?.status,'FAIL');
  }
});

test('documented anonymous 401/42501 and authenticated 403/42501 privilege denials both pass', async () => {
  for(const status of [401,403]){
    const report=await verifyStaging(env,async input=>new URL(String(input)).pathname==='/auth/v1/settings'
      ?json(auth):json({code:'42501',message:'PRIVATE_DENIAL'},status));
    assert.equal(report.status,'BASELINE_PASS');assert.equal(report.checks.length,16);
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
    assert.equal(report.authenticated_acceptance,false);assert.equal(report.migration_revision_verified,false);
  }
});

test('anonymous 401 diagnostics remain bounded, malformed denial cannot pass and later tables are checked',async()=>{
  for(const response of [new Response('PRIVATE_BAD_BODY',{status:401}),json({code:'42501',message:'PRIVATE'.repeat(4000)},401)]){
    const report=await verifyStaging(env,async input=>new URL(String(input)).pathname.endsWith('/agencies')?response:fake()(input));
    assert.equal(report.status,'BASELINE_FAIL');assert.equal(report.checks[1].status,'FAIL');assert.equal(report.checks.at(-1)?.status,'PASS');
    assert.equal(report.checks.length,16);assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
  }
});

test('successful table response is cancelled without reading any customer payload', async () => {
  let cancelled = 0;
  const report = await verifyStaging(env,async (input) => {
    if (new URL(String(input)).pathname === '/auth/v1/settings') return json(auth);
    const response = new Response(new ReadableStream({cancel(){cancelled++;}}));
    Object.defineProperty(response,'json',{value:()=>{throw Error('MUST_NOT_READ');}});
    return response;
  });
  assert.equal(report.status,'BASELINE_FAIL'); assert.equal(cancelled,15);
});

test('timeout/redirect/remote exceptions and malformed or oversized diagnostics stay content-free', async () => {
  for (const fetcher of [
    (async () => {throw Error('PRIVATE_REDIRECT_OR_TIMEOUT');}) as typeof fetch,
    (async () => new Response('PRIVATE_NOT_JSON',{status:403})) as typeof fetch,
    (async () => json({code:'42501',message:'PRIVATE'.repeat(4000)},403)) as typeof fetch,
  ]) {
    const report = await verifyStaging(env,fetcher);
    assert.equal(report.checks.length,16); assert.ok(report.checks.every(check => check.status === 'FAIL'));
    assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
  }
});

test('CLI help and missing explicit flag do not read staging files or connect', () => {
  const script = fileURLToPath(new URL('../scripts/verify-supabase.mjs',import.meta.url));
  for (const args of [['--help','--staging-config','MISSING_PRIVATE_CONFIG'], ['--staging-config','MISSING_PRIVATE_CONFIG']]) {
    const result = spawnSync(process.execPath,['--experimental-strip-types',script,...args],{encoding:'utf8',windowsHide:true,
      env:{...process.env,...env,NEXT_PUBLIC_SUPABASE_URL:'https://localhost',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'PRIVATE_UNSAFE_KEY'}});
    assert.equal(result.status,args[0] === '--help' ? 0 : 1);
    assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_UNSAFE_KEY|ENOENT|MISSING_PRIVATE_CONFIG|fetch failed/);
    if (args[0] !== '--help') assert.match(result.stderr,/BLOCKED/);
  }
});

test('staging inventory matches every migrated public table and real anonymous SQL privileges deny all probes', async () => {
  const db = await localDatabase();
  try {
    const tables = (await db.query<{name:string}>("select tablename name from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.name);
    assert.deepEqual([...stagingTables].sort(),tables);
    await db.exec('set role anon');
    for (const table of stagingTables) {
      await assert.rejects(db.query(`select id from public.${table} limit 0`),(error:any) => error.code === '42501');
    }
  } finally {await db.close();}
});
