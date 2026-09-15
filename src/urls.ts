import ipaddr from 'ipaddr.js';

export function isPublicIP(address: string): boolean {
 try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function publicURL(input: string): URL {
 const url = new URL(input);
 const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
 if (!['https:','http:'].includes(url.protocol) || url.username || url.password ||
   (url.port && !['80','443'].includes(url.port)) || !host.includes('.') && !host.includes(':') ||
   /(^|\.)(localhost|local|internal|home|test|invalid)$/.test(host) ||
   (ipaddr.isValid(host) && !isPublicIP(host))) throw new Error('unsafe_url');
 return url;
}
export function canonicalize(input: string): string {
 const url = publicURL(input);
 // Only provider-specific identity transformations. Unknown query keys and fragments survive.
 const host = url.hostname.toLowerCase();
 if (['www.youtube.com','m.youtube.com','youtube.com','youtu.be'].includes(host)) {
   const id = host === 'youtu.be' ? url.pathname.slice(1) :
     /^\/(shorts|embed)\//.test(url.pathname) ? url.pathname.split('/')[2] : url.searchParams.get('v');
   if (id && /^[\w-]{11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
 }
 for (const key of [...url.searchParams.keys()]) if (/^utm_/.test(key) || ['fbclid','gclid'].includes(key)) url.searchParams.delete(key);
 return url.href;
}
export function timestampURL(url: string, seconds: number): string|null {
 const u = publicURL(url);
 if (u.hostname !== 'www.youtube.com' || u.pathname !== '/watch' || !u.searchParams.has('v')) return null;
 u.searchParams.set('t', String(Math.floor(seconds))); return u.href;
}
