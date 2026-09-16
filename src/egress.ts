import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { isPublicIP, publicURL } from './urls.js';

export type Destination = {address: string; family: number};
// Throws unless the host may be reached; returns the one address to connect to, so a second DNS answer cannot redirect it.
export type EgressPolicy = (host: string, port: number) => Promise<Destination>;
export interface Egress { server: string; close(): Promise<void> }

const IDLE_MS = 15_000;
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const endToEnd = (headers: http.IncomingHttpHeaders) => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP.has(name)));

export const publicDestination: EgressPolicy = async (host, port) => {
 if (port !== 80 && port !== 443) throw new Error('unsafe_port');
 const bare = host.replace(/^\[|\]$/g, '');
 publicURL(`https://${net.isIPv6(bare) ? `[${bare}]` : bare}/`);
 const addresses = await lookup(bare, {all: true, verbatim: true});
 if (!addresses.length || addresses.some(a => !isPublicIP(a.address))) throw new Error('unsafe_destination');
 return addresses[0];
};

// A forward proxy for the page renderer. Every request and tunnel the browser opens is checked here, including
// subresources, redirects and WebSockets, so a rendered page cannot reach loopback, private or metadata addresses.
export async function startEgress(policy: EgressPolicy = publicDestination): Promise<Egress> {
 const server = http.createServer(async (req, res) => {
   let target: URL;
   try { target = new URL(req.url ?? ''); if (target.protocol !== 'http:') throw new Error('unsupported'); }
   catch { res.writeHead(400).end(); return; }
   const port = Number(target.port || 80);
   let destination: Destination;
   try { destination = await policy(target.hostname, port); } catch { res.writeHead(403).end(); return; }
   const upstream = http.request({host: destination.address, family: destination.family, port, method: req.method,
     path: target.pathname + target.search, headers: {...endToEnd(req.headers), host: target.host}, agent: false, timeout: IDLE_MS}, answer => {
     res.writeHead(answer.statusCode ?? 502, endToEnd(answer.headers));
     answer.pipe(res);
   });
   upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
   upstream.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502).end(); });
   req.pipe(upstream);
 });
 const tunnels = new Set<net.Socket>();
 server.on('connect', async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
   tunnels.add(client);
   client.on('error', () => client.destroy()).on('close', () => tunnels.delete(client));
   const match = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(req.url ?? '');
   let destination: Destination;
   try { if (!match) throw new Error('invalid'); destination = await policy(match[1], Number(match[2])); }
   catch { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
   const upstream = net.connect({host: destination.address, family: destination.family, port: Number(match[2])});
   const close = () => { upstream.destroy(); client.destroy(); };
   for (const socket of [upstream, client]) socket.setTimeout(IDLE_MS, close).on('error', close).on('close', close);
   upstream.once('connect', () => {
     client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
     if (head.length) upstream.write(head);
     upstream.pipe(client); client.pipe(upstream);
   });
 });
 server.on('upgrade', (_req, socket: net.Socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
 server.on('clientError', (_error, socket) => socket.destroy());
 await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => resolve()));
 server.unref();
 const {port} = server.address() as net.AddressInfo;
 return {server: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => {
   for (const socket of tunnels) socket.destroy();
   server.closeAllConnections(); server.close(() => resolve());
 })};
}
