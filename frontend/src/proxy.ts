import {NextResponse,type NextRequest} from 'next/server';
import {securityRequestHeaders,browserSecurityHeaders} from '@leadpilot/backend/server/security';
export function proxy(request:NextRequest){
 const development=process.env.NODE_ENV==='development',secured=securityRequestHeaders(request.headers,development);
 const response=NextResponse.next({request:{headers:secured.headers}});
 response.headers.set('Content-Security-Policy',secured.csp);response.headers.set('Cache-Control','private, no-store');
 for(const [key,value] of Object.entries(browserSecurityHeaders({development,https:request.nextUrl.protocol==='https:'})))response.headers.set(key,value);
 return response;
}
export const config={matcher:['/((?!api/|auth/|_next/static|_next/image|favicon.ico).*)']};
