export class ApiError extends Error {
  status: number;
  retryAfter?:number;
  code: string;
  fieldErrors?: Record<string, string>;
  constructor(status: number, code: string, message: string, fieldErrors?: Record<string, string>) {
    super(message); this.status = status; this.code = code; this.fieldErrors = fieldErrors;
  }
}
export function checkOrigin(request: Request) {
  const expected = process.env.APP_URL;
  let origin:string;
  try {
    if(!expected&&process.env.NODE_ENV==='production')throw Error();
    const app=new URL(expected||new URL(request.url).origin);
    if(app.username||app.password||app.search||app.hash||app.pathname!=='/'||!(app.protocol==='https:'||app.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(app.hostname)))throw Error();
    if(process.env.NODE_ENV==='production'&&!['localhost','127.0.0.1','[::1]'].includes(new URL(request.url).hostname)&&['localhost','127.0.0.1','[::1]'].includes(app.hostname))throw Error();
    origin=app.origin;
  }catch{throw new ApiError(503,'APP_NOT_CONFIGURED','Application origin configuration is unavailable.');}
  if(request.headers.get('sec-fetch-site')==='cross-site'||request.headers.get('origin')!==origin)throw new ApiError(403,'ORIGIN_DENIED','Request origin is not allowed.');
}
export async function readRaw(request:Request,maxBytes=256*1024):Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_JSON', 'A JSON body is required.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body exceeds the allowed limit.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function readJson(request:Request,maxBytes=256*1024):Promise<unknown>{
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'JSON_REQUIRED', 'Use application/json.');
  const bytes=await readRaw(request,maxBytes);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'Provide valid JSON.'); }
}
export function databaseError(error: {code?:string;message?:string}): never {
  const code = error.message;
  const known: Record<string, [number, string]> = {
    DRAFT_DISABLED:[503,'Reviewed drafts are disabled until approved configuration is complete.'], DRAFT_IN_PROGRESS:[409,'Another draft with different parameters is already queued for this customer context.'], DRAFT_LANGUAGE_UNAPPROVED:[422,'This draft language is not approved.'], DRAFT_STALE:[409,'Customer context changed. Regenerate this draft before review or copy.'], DRAFT_REVIEW_REQUIRED:[422,'Explicitly review and approve the current text with your account before copying.'], DRAFT_UNSAFE:[422,'This draft is withheld. Correct unsafe claims before approval.'], COPY_EXPIRED:[409,'Copy authorization expired. Request a fresh copy.'], EXTERNAL_LOG_CONFIRMATION_REQUIRED:[422,'Confirm an actual external message after a completed copy, or use manual conversation logging.'], AI_DISABLED:[503,'AI analysis is disabled until platform configuration and approvals are complete.'], AI_LIMIT_REQUIRED:[422,'The owner must configure daily and monthly AI limits.'], AI_QUOTA_REACHED:[409,'The agency AI operation limit has been reached.'], AI_RATE_LIMITED:[429,'At most ten new analysis jobs per user per hour are allowed.'], PROVENANCE_IMMUTABLE:[422,'Source provenance and website messages cannot be edited.'], INTEGRATION_LIMIT:[422,'Use at most 20 website integrations per agency.'], INTAKE_UNAVAILABLE:[401,'Website signature is invalid.'],
    RATE_LIMITED:[429,'Too many requests. Wait a minute and retry.'], WORKER_REQUIRED:[403,'Worker authorization is required.'], RECENT_MFA_REQUIRED:[403,'Verify your authenticator in Settings and retry within five minutes.'], SEAT_LIMIT_REQUIRED:[422,'The owner must configure the pilot seat limit before inviting or reactivating members.'], SEAT_LIMIT_REACHED:[409,'The seat limit includes active members and pending invitations.'], INVITATION_UNAVAILABLE:[422,'This invitation is unavailable. Check your verified email or request a new link.'], INVITATION_EXISTS:[409,'A pending invitation already exists for this email in this agency.'], MEMBER_EXISTS:[409,'This email already has a membership in this agency. Manage the existing membership.'], WORKLOAD_CONFIRMATION_REQUIRED:[422,'Confirm transfer of work to a replacement or the manager queue.'], PROCESSING_REQUIRED:[422,'Record processing approval and configure the AI limit first.'], AUTH_REQUIRED:[401,'Sign in with a verified email.'], MEMBERSHIP_REQUIRED:[403,'Active agency membership is required.'],
    NOT_FOUND:[404,'This record is unavailable.'], VERSION_CONFLICT:[409,'This record changed. Reload before saving.'],
    IDEMPOTENCY_CONFLICT:[409,'This request key was already used with different input.'],
    INTAKE_SIGNING_POLICY_CONFLICT:[409,'Intake signing policy changed. Retry with the same request key.'], INVITATION_KEY_POLICY_CONFLICT:[409,'Invitation signing policy changed. Retry with the same request key.'], INTAKE_KEY_POLICY_CONFLICT:[409,'Encryption policy changed. Retry with the same request key.'], PRIVACY_CASE_EXISTS:[409,'An open privacy request already exists for this scope. Review it in Settings.'], ROLE_REQUIRED:[403,'A manager role is required for this action.'], STATE_CONFLICT:[409,'This record is already in that state. Reload before saving.'], TASK_TRANSFER_CONFIRMATION_REQUIRED:[422,'Confirm transfer of open tasks before changing assignment.'],
    STATUS_REQUIREMENT:[422,'This transition requires contact evidence, qualification details or an open follow up.'], TASK_CONFIRMATION_REQUIRED:[422,'Confirm cancellation of open tasks before closing the lead.'], TASK_NOT_OPEN:[409,'This task is already closed. Reload before saving.'],
    VALIDATION_FAILED:[422,'Check the supplied fields.'], CONTACT_BLOCKED:[422,'Outreach is blocked for this lead.'],
  };
  if (code && known[code]) throw new ApiError(known[code][0], code, known[code][1]);
  throw new ApiError(503,'DATABASE_UNAVAILABLE','The database operation could not complete. Retry with the same request key.');
}
export async function api(operation: (requestId: string) => Promise<unknown>, status = 200) {
  const started=performance.now(),requestId = crypto.randomUUID(); const headers:Record<string,string> = {'Cache-Control':'private, no-store','X-Request-Id':requestId};
  const record=(resultStatus:number)=>{if(process.env.OPERATIONAL_LOGS_ENABLED==='true')console.info(JSON.stringify({event:'api_result',request_id:requestId,status:resultStatus,duration_ms:Math.round(performance.now()-started)}));};
  try { const data=await operation(requestId);record(status);return Response.json({data}, {status,headers}); }
  catch (error) {
    const safe = error instanceof ApiError ? error : new ApiError(503,'SERVICE_UNAVAILABLE','Service temporarily unavailable.');
    record(safe.status);
    if(safe.status===429)headers['Retry-After']=String(Math.max(1,Math.min(60,Math.ceil(safe.retryAfter??60))));
    return Response.json({error:{code:safe.code,message:safe.message,field_errors:safe.fieldErrors,request_id:requestId,retryable:safe.status===503||safe.status===429,retry_after:safe.status===429?Number(headers['Retry-After']):undefined}}, {status:safe.status,headers});
  }
}
