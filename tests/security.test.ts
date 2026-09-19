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
import { signMedia, verifyMedia } from '../src/signing.js';
import { createApp } from '../src/app.js';
import { SearchService } from '../src/search.js';
import { ingest } from '../src/catalogue.js';
import { workOnce } from '../src/worker.js';
import { imageSearchInput, searchImages } from '../src/images.js';
import { contentInput, type SourceAdapter } from '../src/types.js';
import { database, fixture } from './helpers.js';

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
   else if(req.url==='/quota'){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{status:'RESOURCE_EXHAUSTED',
     details:[{violations:[{quotaId:'GenerateRequestsPerDayPerProjectPerModel-FreeTier'}]},{retryDelay:'17s'}]}}));}
   else {res.setHeader('content-type','text/html');res.end('<h1>Wrong format</h1>');}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 try{
   await assert.rejects(fetchJSON(`${origin}/redirect`,{trustedOrigin:origin}),/redirect_blocked/);
   await assert.rejects(fetchJSON(`${origin}/big`,{trustedOrigin:origin,maxBytes:100}),/response_too_large/);
   await assert.rejects(fetchJSON(`${origin}/html`,{trustedOrigin:origin}),/unsupported_content/);
   await assert.rejects(fetchJSON(`${origin}/quota`,{trustedOrigin:origin}),(e:any)=>e.code==='rate_limited'&&e.status===429&&
     e.detail==='RESOURCE_EXHAUSTED,GenerateRequestsPerDayPerProjectPerModel-FreeTier,retry=17s','a trusted API names the exhausted quota');
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
 let observed='';const adapter=new SearXNG({...testConfig,SEARXNG_BASE_URL:'http://localhost:8080',SEARXNG_ENGINES:'youtube'},async(url)=>{
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
test('a media signature verifies only for the exact URL it was issued for, under this secret',()=>{
 const url='https://cdn.example.org/a/thumb.jpg';const sig=signMedia(testConfig,url);
 assert.match(sig,/^[A-Za-z0-9_-]{43}$/,'base64url of a SHA-256 MAC');
 assert.equal(verifyMedia(testConfig,url,sig),true,'a valid signature passes');
 assert.equal(verifyMedia(testConfig,`${url}?x=1`,sig),false,'a changed URL fails');
 assert.equal(verifyMedia({...testConfig,SESSION_SECRET:'rotated-session-secret-32-characters!'},url,sig),false,'a rotated secret invalidates it');
 // timingSafeEqual throws on unequal lengths, so a malformed signature must be turned away before the comparison.
 for(const bad of [undefined,'','short',`${sig}A`,sig.slice(1),'!'.repeat(43)])assert.equal(verifyMedia(testConfig,url,bad),false,String(bad));
});
test('the thumbnail proxy only fetches URLs this server signed',async()=>{
 const db=await database();const app=await createApp(db,testConfig);
 try{
   const get=(query:Record<string,string>)=>app.inject(`/api/thumbnail?${new URLSearchParams(query)}`);
   const url='https://cdn.example.org/a/thumb.jpg';
   const missing=await get({url});
   assert.equal(missing.statusCode,403,'an unsigned request is refused');assert.equal(missing.json().error.code,'invalid_signature');
   const tampered=await get({url:'https://cdn.example.org/a/other.jpg',sig:signMedia(testConfig,url)});
   assert.equal(tampered.statusCode,403,'a well-formed signature for a different URL is refused');
   assert.equal((await get({url,sig:'not-a-signature'})).statusCode,403);
   // A valid signature gets past the gate; the egress guard still sits behind it, so it is refused there and not as a 403.
   const internal='http://127.0.0.1/x.jpg';
   const signedInternal=await get({url:internal,sig:signMedia(testConfig,internal)});
   assert.equal(signedInternal.statusCode,400);assert.equal(signedInternal.json().error.code,'unsafe_url');
 }finally{await app.close();await db.close();}
});
test('every result sent to the client carries a signature for its exact thumbnail URL',async()=>{
 const db=await database();
 try{
   const config={...testConfig,SEARXNG_BASE_URL:'http://localhost:8080'};const service=new SearchService(db,config);
   const plain=await fixture(db,'Bedroom footage','A bright bedroom');
   // Stored as given, so the emitted string is not the URL parser's normalised form; the signature has to cover what is sent.
   const stored='https://Cdn.Example.org';
   await ingest(db,contentInput.parse({url:`https://videos.example.com/watch/${crypto.randomUUID()}`,title:'Bright bedroom with a picture',
     description:'Bright bedroom tour',duration:60,availability:'available',thumbnail:stored}),{fixture:true});
   const adapter:SourceAdapter={name:'mock',capabilities:{transcripts:false,comments:false,embeds:false,accessible_media:false},
     async search(){return {results:[contentInput.parse({url:'https://videos.example.com/watch/discovered?id=2',title:'Bright bedroom discovery',
       description:'Bright bedroom tour',thumbnail:'https://cdn.example.org/found.jpg'})],next_cursor:null,status:{provider:'mock',status:'ok',message:'Mocked provider'}};}};
   const started=await service.start({q:'bedroom',mode:'auto'},'alice');
   await workOnce(db,config,[adapter]);
   const finished=await service.poll(started.search_id,'alice');
   const catalogue=finished.results.filter(r=>r.origin==='catalogue');const found=finished.discovered;
   assert.equal(catalogue.length,2);assert.equal(found.length,1);
   for(const r of [...catalogue,...found]){
     if(r.thumbnail===null){assert.equal(r.thumbnail_sig,undefined,'no thumbnail, no signature');continue;}
     assert.equal(verifyMedia(config,r.thumbnail,r.thumbnail_sig),true,r.thumbnail);
   }
   assert.equal(catalogue.find(r=>r.id===plain.id)!.thumbnail_sig,undefined);
   assert.equal(catalogue.find(r=>r.thumbnail===stored)!.thumbnail,stored,'the catalogue row is emitted as stored');
   assert.equal(found[0].thumbnail,'https://cdn.example.org/found.jpg');
   assert.equal(verifyMedia(config,found[0].thumbnail!,catalogue.find(r=>r.thumbnail===stored)!.thumbnail_sig),false,'a signature does not carry over to another URL');
 }finally{await db.close();}
});
test('image results are emitted with a signature for their thumbnail',async()=>{
 const db=await database();
 const searxng=createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({results:[
   {url:'https://example.org/page',title:'Cat',img_src:'https://cdn.example.org/full.jpg',thumbnail_src:'https://cdn.example.org/thumb.jpg',engine:'bing images'},
   {url:'https://example.net/other',title:'Dog',img_src:'https://cdn.example.net/only.jpg',engine:'bing images'}]}));});
 await new Promise<void>(r=>searxng.listen(0,'127.0.0.1',r));
 const config={...testConfig,SEARXNG_BASE_URL:`http://127.0.0.1:${(searxng.address() as any).port}`};
 try{
   const {results}=await searchImages(db,config,imageSearchInput.parse({q:'pets'}));
   assert.equal(results.length,2);
   assert.equal(results[0].thumbnail,'https://cdn.example.org/thumb.jpg');
   assert.equal(results[1].thumbnail,results[1].image_url,'an image with no thumbnail of its own is proxied from the full image');
   for(const image of results)assert.equal(verifyMedia(config,image.thumbnail,image.thumbnail_sig),true,image.thumbnail);
   assert.equal(verifyMedia(config,results[1].thumbnail,results[0].thumbnail_sig),false);
 }finally{await new Promise<void>(r=>{searxng.closeAllConnections();searxng.close(()=>r());});await db.close();}
});
