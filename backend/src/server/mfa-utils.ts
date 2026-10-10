import {ApiError} from './http.ts';
export function recentMfa(claims:unknown,now=Math.floor(Date.now()/1000)){
 if(!claims||typeof claims!=='object')return false;const c=claims as {aal?:unknown;amr?:unknown};
 return c.aal==='aal2'&&Array.isArray(c.amr)&&c.amr.some(a=>a&&typeof a==='object'&&['totp','mfa/totp'].includes(a.method)&&typeof a.timestamp==='number'&&Number.isFinite(a.timestamp)&&a.timestamp<=now&&a.timestamp>=now-300);
}
export function authenticatorQr(value:string){
 // This installed Auth SDK prefixes the raw SVG, so remove that prefix before encoding.
 const prefix='data:image/svg+xml;utf-8,';const svg=value.startsWith(prefix)?value.slice(prefix.length):value;
 if(!/^\s*<svg[\s>]/.test(svg))throw new ApiError(503,'MFA_QR_UNAVAILABLE','Use the manual authenticator setup key.');
 return 'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
}
