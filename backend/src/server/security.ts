import {randomBytes} from 'node:crypto';
import {ApiError} from './http.ts';
const loopback=(host:string)=>['localhost','127.0.0.1','[::1]'].includes(host);
export function appOrigin(requestUrl:string,env:Record<string,string|undefined>=process.env){
 try{
  const request=new URL(requestUrl);if(!env.APP_URL&&env.NODE_ENV==='production')throw Error();
  const app=new URL(env.APP_URL||request.origin);
  if(app.username||app.password||app.search||app.hash||app.pathname!=='/'||!(app.protocol==='https:'||app.protocol==='http:'&&loopback(app.hostname)))throw Error();
  if(env.NODE_ENV==='production'&&!loopback(request.hostname)&&loopback(app.hostname))throw Error();
  return app.origin;
 }catch{throw new ApiError(503,'APP_NOT_CONFIGURED','Application origin configuration is unavailable.');}
}
export function browserSecurityHeaders({development=false,https=false}:{development?:boolean;https?:boolean}={}){
 const result:Record<string,string>={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()','Cross-Origin-Opener-Policy':'same-origin'};
 if(!development&&https)result['Strict-Transport-Security']='max-age=31536000';
 return result;
}
export function contentSecurityPolicy(nonce:string,development=false){
 if(!/^[A-Za-z0-9+/=]{24,64}$/.test(nonce))throw Error('INVALID_NONCE');
 return [`default-src 'self'`,`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development?" 'unsafe-eval'":''}`,`script-src-attr 'none'`,
  // Existing React/Radix styles include style attributes. This does not relax scripts.
  `style-src 'self' 'unsafe-inline'`,`img-src 'self' data: blob:`,`font-src 'self'`,`connect-src 'self'${development?' ws: wss:':''}`,`object-src 'none'`,`base-uri 'none'`,`form-action 'self'`,`frame-ancestors 'none'`,`frame-src 'none'`,`worker-src 'self'`,`manifest-src 'self'`].join('; ');
}
export function securityRequestHeaders(incoming:Headers,development=false){const nonce=randomBytes(18).toString('base64'),csp=contentSecurityPolicy(nonce,development),headers=new Headers(incoming);headers.set('x-nonce',nonce);headers.set('Content-Security-Policy',csp);return {nonce,csp,headers};}
