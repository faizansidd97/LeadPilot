// Anonymous, read-only probes are a baseline, never authenticated acceptance.
export const stagingTables = [
  'agencies', 'memberships', 'leads', 'messages', 'activity_events',
  'follow_ups', 'invitations', 'notifications', 'message_revisions',
  'ai_jobs', 'ai_analyses', 'reply_drafts', 'draft_feedback',
  'privacy_cases', 'privacy_case_actions',
] as const;

export function stagingConfiguration(env: Record<string, string | undefined>) {
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  let url: URL;
  try { url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? ''); }
  catch { throw Error('INVALID_STAGING_CONFIGURATION'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw Error('INVALID_STAGING_CONFIGURATION');
  }
  let publicKey = !!key && /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!publicKey && key) {
    try {
      const parts = key.split('.');
      publicKey = parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)) &&
        JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role === 'anon';
    } catch { publicKey = false; }
  }
  if (!publicKey || !key) throw Error('INVALID_STAGING_CONFIGURATION');
  return { url: url.origin, key };
}

type Probe = { check: string; status: 'PASS' | 'FAIL'; reason: string };
const bodyLimit = 16384;
async function smallJson(response: Response): Promise<any> {
  if (!response.body) throw Error('EMPTY_BODY');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > bodyLimit) throw Error('BODY_LIMIT');
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function verifyStaging(
  env: Record<string, string | undefined>, fetcher: typeof fetch = fetch,
) {
  // Validate before constructing requests; only the public key crosses the wire.
  const config = stagingConfiguration(env);
  const checks: Probe[] = [];
  const request = (pathname: string) => fetcher(new URL(pathname, config.url), {
    method: 'GET', headers: { apikey: config.key, 'Accept-Profile': 'public' },
    cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  try {
    const response = await request('/auth/v1/settings');
    if (!response.ok) {
      await response.body?.cancel();
      checks.push({ check: 'auth_configuration', status: 'FAIL', reason: 'AUTH_UNAVAILABLE' });
    } else {
      const body = await smallJson(response);
      const expected = body && body.external?.email === true &&
        body.mailer_autoconfirm === false && body.disable_signup === false;
      checks.push({ check: 'auth_configuration', status: expected ? 'PASS' : 'FAIL',
        reason: expected ? 'EMAIL_SIGNUP_REQUIRES_CONFIRMATION' : 'EMAIL_SIGNUP_CONFIGURATION_MISMATCH' });
    }
  } catch {
    checks.push({ check: 'auth_configuration', status: 'FAIL', reason: 'PROBE_UNAVAILABLE' });
  }
  for (const table of stagingTables) {
    try {
      const response = await request(`/rest/v1/${table}?select=id&limit=0`);
      // Never read a successful table response, even if access is accidentally open.
      // PostgREST maps 42501 to 401 for anonymous requests and 403 for authenticated ones.
      if (response.status !== 401 && response.status !== 403) {
        await response.body?.cancel();
        checks.push({ check: table, status: 'FAIL', reason: 'ANONYMOUS_DENIAL_NOT_PROVEN' });
      } else {
        const body = await smallJson(response);
        const denied = body?.code === '42501';
        checks.push({ check: table, status: denied ? 'PASS' : 'FAIL',
          reason: denied ? 'ANONYMOUS_TABLE_ACCESS_DENIED' : 'ANONYMOUS_DENIAL_NOT_PROVEN' });
      }
    } catch {
      checks.push({ check: table, status: 'FAIL', reason: 'PROBE_UNAVAILABLE' });
    }
  }
  return {
    status: checks.every(check => check.status === 'PASS') ? 'BASELINE_PASS' : 'BASELINE_FAIL',
    checks, authenticated_acceptance: false, migration_revision_verified: false,
    worker_verified: false, browser_accepted: false, release_accepted: false,
  };
}
