import {test} from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, isPublicIP, publicURL } from '../src/urls.js';
import { fetchJSON } from '../src/http.js';
import { SearXNG } from '../src/providers.js';
import { searchInput } from '../src/types.js';
import { testConfig } from './helpers.js';
import { createServer, request as httpRequest } from 'node:http';
import { publicDestination, startEgress } from '../src/egress.js';
import { reciprocalRankFusion } from '../src/ranking.js';

test('URL validation blocks private, metadata and unsafe schemes while preserving content identity',async()=>{
 for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.1.2','192.168.1.2','100.64.0.1','::1','::ffff:127.0.0.1','fe80::1','fc00::1','0.0.0.0'])assert.equal(isPublicIP(address),false,address);
 for(const url of ['file:///etc/passwd','javascript:alert(1)','http://127.0.0.1','http://[::ffff:127.0.0.1]','http://localhost','https://user:pass@example.com','http://0x7f000001'])assert.throws(()=>publicURL(url),url);
 await assert.rejects(fetchJSON('http://localhost.localdomain/'),/unsafe|network/);
 assert.equal(canonicalize('https://youtu.be/abcdefghijk?t=40'),'https://www.youtube.com/watch?v=abcdefghijk');
 assert.notEqual(canonicalize('https://example.com/watch?id=1'),canonicalize('https://example.com/watch?id=2'));
 assert.equal(canonicalize('https://example.com/watch?id=1&utm_source=test'),'https://example.com/watch?id=1');
});
test('fixed internal providers reject redirects and bound response size/type',async()=>{
 const server=createServer((req,res)=>{
   if(req.url==='/redirect'){res.writeHead(302,{location:'http://169.254.169.254/latest/meta-data/'});res.end();}
   else if(req.url==='/big'){res.setHeader('content-type','application/json');res.end(JSON.stringify({value:'x'.repeat(10000)}));}
   else {res.setHeader('content-type','text/html');res.end('<h1>Wrong format</h1>');}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
   await assert.rejects(fetchJSON(`${origin}/redirect`,{trustedOrigin:origin}),/redirect_blocked/);
   await assert.rejects(fetchJSON(`${origin}/big`,{trustedOrigin:origin,maxBytes:100}),/response_too_large/);
   await assert.rejects(fetchJSON(`${origin}/html`,{trustedOrigin:origin}),/unsupported_content/);
   const probe=await fetchJSON(`${origin}/html`,{trustedOrigin:origin,method:'HEAD',probe:true});
   assert.equal(probe.status,200,'health probes read headers without parsing HTML as JSON');
 }finally{await new Promise<void>(r=>server.close(()=>r()));}
});
test('the renderer egress proxy only reaches public web ports and forwards what its policy allows',async()=>{
 for(const [host,port] of [['127.0.0.1',443],['localhost',443],['10.1.2.3',80],['169.254.169.254',80],['[::1]',443],['example.com',8080],['metadata.internal',443]] as const)
   await assert.rejects(publicDestination(host,port),`${host}:${port}`);
 let hits:string[]=[];
 const target=createServer((req,res)=>{hits.push(`${req.headers.host} ${req.url}`);res.end('hello');});
 await new Promise<void>(r=>target.listen(0,'127.0.0.1',r));
 const port=(target.address() as any).port;
 const strict=await startEgress();
 const allowing=await startEgress(async(host,p)=>{if(host==='allowed.test'&&p===port)return {address:'127.0.0.1',family:4};throw new Error('blocked');});
 const proxyPort=(egress:{server:string})=>Number(new URL(egress.server).port);
 const get=(egress:{server:string},url:string)=>new Promise<{status:number;body:string}>((resolve,reject)=>
   httpRequest({host:'127.0.0.1',port:proxyPort(egress),path:url},res=>{let body='';res.on('data',c=>body+=c).on('end',()=>resolve({status:res.statusCode!,body}));})
     .on('error',reject).end());
 const tunnel=(egress:{server:string},authority:string)=>new Promise<{status:number;socket:import('node:net').Socket}>((resolve,reject)=>
   httpRequest({host:'127.0.0.1',port:proxyPort(egress),method:'CONNECT',path:authority}).on('connect',(res,socket)=>resolve({status:res.statusCode!,socket}))
     .on('error',reject).end());
 try{
   assert.equal((await get(strict,`http://127.0.0.1:${port}/private`)).status,403);
   const refused=await tunnel(strict,`127.0.0.1:${port}`);refused.socket.destroy();
   assert.equal(refused.status,403);
   assert.deepEqual(hits,[],'nothing reached the loopback service');
   assert.deepEqual(await get(allowing,`http://allowed.test:${port}/page?q=1`),{status:200,body:'hello'});
   assert.deepEqual(hits,[`allowed.test:${port} /page?q=1`],'the original host name is forwarded');
   const open=await tunnel(allowing,`allowed.test:${port}`);
   assert.equal(open.status,200);
   const reply=await new Promise<string>(resolve=>{let data='';open.socket.on('data',c=>data+=c).on('end',()=>resolve(data));
     open.socket.end(`GET /tunnelled HTTP/1.1\r\nHost: allowed.test\r\nConnection: close\r\n\r\n`);});
   assert.match(reply,/200 OK[\s\S]*hello$/);
   hits=[];
   const other=await tunnel(allowing,`127.0.0.1:${port}`);other.socket.destroy();
   assert.equal(other.status,403);
   assert.deepEqual(hits,[]);
 }finally{await strict.close();await allowing.close();await new Promise<void>(r=>{target.closeAllConnections();target.close(()=>r());});}
});
test('SearXNG validates individual results, preserves query phrases and reports partial engines',async()=>{
 let observed='';const adapter=new SearXNG({...testConfig,SEARXNG_BASE_URL:'http://localhost:8080'},async(url)=>{
   observed=url;return {results:[{url:'javascript:alert(1)',title:'bad'},{url:'https://example.com/watch?id=3',title:'Legitimate video'}],unresponsive_engines:[['youtube','timeout']]};
 });
 const input=searchInput.parse({q:'  "ghost story" -fake  '});const page=await adapter.search(input.q,input);
 assert.equal(new URL(observed).searchParams.get('q'),'"ghost story" -fake');assert.equal(page.results.length,1);
 assert.equal(page.results[0].duration,null);assert.equal(page.status.status,'partial');
 assert.equal(reciprocalRankFusion([['a','b'],['b','a']]).get('a'),reciprocalRankFusion([['a','b'],['b','a']]).get('b'));
});
test('superseded browser requests cannot commit old results',async()=>{
 // @ts-expect-error The same small browser module is intentionally plain JavaScript.
 const {SearchController}=await import('../public/search-controller.js');const controller=new SearchController();
 const old=controller.begin();const current=controller.begin();assert.equal(old.signal.aborted,true);
 const commits:string[]=[];
 await Promise.all([new Promise<void>(r=>setTimeout(()=>{if(controller.current(old.generation))commits.push('old');r();},20)),
   Promise.resolve().then(()=>{if(controller.current(current.generation))commits.push('current');})]);
 assert.deepEqual(commits,['current']);
});
