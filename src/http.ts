import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isPublicIP, publicURL } from './urls.js';

// detail: the reasons a trusted API gave for an error response (for example a quota name); never shown to users.
export class UpstreamError extends Error { constructor(public code: string, public status?: number, public detail?: string) { super(code); } }
function errorDetail(body: Buffer) {
 try {
   const error = JSON.parse(body.toString('utf8'))?.error ?? {};
   const reasons = [error.status, ...(error.errors ?? []).map((e: any) => e?.reason), ...(error.details ?? []).map((d: any) => d?.reason),
     ...(error.details ?? []).flatMap((d: any) => (d?.violations ?? []).map((v: any) => v?.quotaId)),
     ...(error.details ?? []).flatMap((d: any) => typeof d?.retryDelay === 'string' ? [`retry=${d.retryDelay}`] : [])];
   return reasons.filter((r): r is string => typeof r === 'string').join(',').slice(0, 300) || undefined;
 } catch { return undefined; }
}
type Options = { timeoutMs?: number; maxBytes?: number; method?: 'GET'|'POST'|'HEAD'; body?: unknown;
 token?: string; trustedOrigin?: string; contentTypes?: string[]; redirects?: number;
 headers?: Record<string,string>; probe?: boolean; accept?: string };
export interface ProbeResponse {status:number;url:string;redirects:{from:string;to:string;status:number}[]}
export interface TextResponse {url:string;contentType:string;text:string}
export interface BinaryResponse {url:string;contentType:string;data:Buffer}
type Raw = {status:number;url:string;contentType:string;data:Buffer;redirects:ProbeResponse['redirects']};

// Pin the validated DNS answer into the connection. Redirects repeat validation and never inherit credentials.
async function request(input: string, options: Options, defaultTypes: string[]): Promise<Raw> {
 const started = Date.now();
 const deadline = options.timeoutMs ?? 5000;
 let target = input;
 const chain:ProbeResponse['redirects']=[];
 for (let redirects = 0; redirects <= (options.redirects ?? 2); redirects++) {
   const url = new URL(target);
   const trusted = options.trustedOrigin && url.origin === options.trustedOrigin;
   if (url.username || url.password || !['http:','https:'].includes(url.protocol)) throw new UpstreamError('unsafe_url');
   if (!trusted) publicURL(target);
   const remaining = deadline - (Date.now() - started);
   if (remaining <= 0) throw new UpstreamError('timeout');
   const response = await new Promise<{status: number; location?: string; contentType: string; data: Buffer}>((resolve, reject) => {
     let req: http.ClientRequest | undefined;
     const timer = setTimeout(() => { req?.destroy(); reject(new UpstreamError('timeout')); }, remaining);
     const finish = (error?: Error, value?: {status: number; location?: string; contentType: string; data: Buffer}) => {
       clearTimeout(timer); if (error) reject(error); else resolve(value!);
     };
     void (async () => {
       const hostname = url.hostname.replace(/^\[|\]$/g, '');
       const addresses = await lookup(hostname, { all: true, verbatim: true });
       if (!addresses.length || (!trusted && addresses.some(a => !isPublicIP(a.address)))) throw new UpstreamError('unsafe_destination');
       if (Date.now() - started >= deadline) throw new UpstreamError('timeout');
       const chosen = addresses[0];
       const body = options.body === undefined ? undefined : JSON.stringify(options.body);
       req = (url.protocol === 'https:' ? https : http).request(url, {
         method: options.method ?? 'GET', agent: false,
         lookup: ((_h: unknown, opts: any, cb: any) => opts.all ? cb(null, [chosen]) : cb(null, chosen.address, chosen.family)) as any,
         headers: { Accept: options.accept ?? (options.probe?'*/*':'application/json'), 'Accept-Encoding': 'identity', 'User-Agent': 'ZenAtlas/0.1',
           ...(body ? {'Content-Type':'application/json','Content-Length': Buffer.byteLength(body)} : {}),
           ...(trusted && options.token ? {Authorization: `Bearer ${options.token}`} : {}),
           ...(trusted ? options.headers : {}) },
       }, res => {
         const status = res.statusCode ?? 502;
         if (status >= 300 && status < 400 && res.headers.location) {
           res.destroy(); finish(undefined, {status, location: res.headers.location, contentType: '', data: Buffer.alloc(0)}); return;
         }
         if(options.probe){res.destroy();finish(undefined,{status,contentType:'',data:Buffer.alloc(0)});return;}
         if (status !== 200) {
           const fail = (detail?: string) => finish(new UpstreamError(status === 429 ? 'rate_limited' : 'upstream_failure', status, detail));
           if (!trusted) { res.destroy(); fail(); return; }
           // A trusted API's error body names the limit or reason; up to 64 KiB of it is read.
           const chunks: Buffer[] = []; let bytes = 0;
           res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) res.destroy(); else chunks.push(chunk); });
           res.on('close', () => fail(errorDetail(Buffer.concat(chunks))));
           return;
         }
         const type = (res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
         if (!(options.contentTypes ?? defaultTypes).includes(type) ||
           (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
           res.destroy(); finish(new UpstreamError('unsupported_content')); return;
         }
         const chunks: Buffer[] = []; let bytes = 0;
         res.on('data', (chunk: Buffer) => {
           bytes += chunk.length;
           if (bytes > (options.maxBytes ?? 1024 * 1024)) { res.destroy(); finish(new UpstreamError('response_too_large')); }
           else chunks.push(chunk);
         });
         res.on('end', () => finish(undefined, {status, contentType: type, data: Buffer.concat(chunks)}));
         res.on('error', () => finish(new UpstreamError('network_error')));
       });
       req.on('error', () => finish(new UpstreamError('network_error')));
       req.end(body);
     })().catch(e => finish(e instanceof UpstreamError ? e : new UpstreamError('network_error')));
   });
   if (response.location) {
     if (trusted) throw new UpstreamError('redirect_blocked');
     const next=publicURL(new URL(response.location, url).href);
     if(url.protocol==='https:' && next.protocol!=='https:')throw new UpstreamError('unsafe_redirect');
     chain.push({from:url.href,to:next.href,status:response.status});target=next.href;
     continue;
   }
   return {status:response.status,url:url.href,contentType:response.contentType,data:response.data,redirects:chain};
 }
 throw new UpstreamError('too_many_redirects');
}

export async function fetchJSON(input: string, options: Options = {}): Promise<any> {
 const response = await request(input, options, ['application/json','application/feed+json']);
 if(options.probe)return {status:response.status,url:response.url,redirects:response.redirects} satisfies ProbeResponse;
 try { return JSON.parse(response.data.toString('utf8')); } catch { throw new UpstreamError('malformed_response'); }
}

export async function fetchText(input: string, options: Options = {}): Promise<TextResponse> {
 const response = await request(input, {accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8', ...options}, ['text/html','application/xhtml+xml']);
 return {url: response.url, contentType: response.contentType, text: response.data.toString('utf8')};
}

export async function fetchImage(input: string, options: Options = {}): Promise<BinaryResponse> {
 const response = await request(input, {accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8', maxBytes: 3*1024*1024, ...options},
   ['image/jpeg','image/png','image/webp','image/gif','image/avif']);
 return {url: response.url, contentType: response.contentType, data: response.data};
}

export async function fetchPDF(input: string, options: Options = {}): Promise<BinaryResponse> {
 const response = await request(input, {accept: 'application/pdf', ...options}, ['application/pdf']);
 return {url: response.url, contentType: response.contentType, data: response.data};
}

export async function probeURL(url:string,timeoutMs=5000):Promise<ProbeResponse>{
 const result=await fetchJSON(url,{method:'HEAD',probe:true,timeoutMs,redirects:2});
 // Some sites do not implement HEAD; consume headers only on the GET fallback.
 return result.status===405 || result.status===501 ? fetchJSON(url,{method:'GET',probe:true,timeoutMs,redirects:2}):result;
}
