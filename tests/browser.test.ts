import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type Server} from 'node:http';
import {spawnSync} from 'node:child_process';
import {chromium} from 'playwright';
import {BrowserRenderer} from '../src/render.js';
import {Trafilatura} from '../src/extract.js';
import type {EgressPolicy} from '../src/egress.js';

const chromiumReady=await chromium.launch().then(b=>b.close().then(()=>true),()=>false);
const python=process.platform==='win32'?'scene-worker/.venv/Scripts/python.exe':'scene-worker/.venv/bin/python';
const trafilaturaReady=spawnSync(python,['-c','import zenatlas_scenes.pagetext']).status===0;
const listen=async(server:Server)=>{await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return (server.address() as any).port as number;};
const stop=(server:Server)=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());});
const ARTICLE=Array(6).fill('The studio builds real-time 3D product scenes with custom shaders and scroll-driven camera paths.').join(' ');

test('the browser renderer sees runtime libraries and WebGL, captures the first screen, and cannot reach other local services',
 {skip:!chromiumReady&&'Chromium is not installed (npx playwright install --only-shell chromium)'},async()=>{
 const leaks:string[]=[];
 const internal=createServer((req,res)=>{leaks.push(req.url??'');res.end('secret');});
 const internalPort=await listen(internal);
 const site=createServer((req,res)=>{
   if(req.url==='/vendor/app-9f3c.js'){res.setHeader('content-type','text/javascript');
     res.end(`window.__THREE__='170';const c=document.createElement('canvas');c.width=64;c.height=64;document.body.prepend(c);c.getContext('webgl');`);}
   else if(req.url==='/gsap.min.js'){res.setHeader('content-type','text/javascript');res.end('');}
   else {res.setHeader('content-type','text/html');res.end(`<!doctype html><html><head><title>Orbit Studio</title></head>
     <body style="background:#123"><nav>Home Work Cookie settings</nav><main><article><h1>Orbit</h1><p>${ARTICLE}</p></article></main>
     <img src="http://127.0.0.1:${internalPort}/image.png"><iframe src="http://localhost:${internalPort}/frame"></iframe>
     <script src="/vendor/app-9f3c.js" defer></script><script src="/gsap.min.js" defer></script>
     <script>fetch('http://127.0.0.1:${internalPort}/fetch').catch(()=>{});new Image().src='http://[::1]:${internalPort}/v6';
       try{new WebSocket('ws://127.0.0.1:${internalPort}/ws')}catch{}</script></body></html>`);}
 });
 const sitePort=await listen(site);
 // Only the test site is reachable; the internal service shares its address but not its port.
 const policy:EgressPolicy=async(host,port)=>{if(host==='127.0.0.1'&&port===sitePort)return {address:'127.0.0.1',family:4};throw new Error('blocked');};
 const renderer=new BrowserRenderer(15000,policy);
 try{
   const page=await renderer.render(`http://127.0.0.1:${sitePort}/`);
   assert.match(page.html,/Orbit Studio/);
   assert.deepEqual(['three.js','WebGL','Canvas'].filter(name=>page.detected.includes(name)),['three.js','WebGL','Canvas']);
   assert.ok(page.scripts.some(url=>url.endsWith('/gsap.min.js')),'loaded script URLs are recorded');
   assert.ok(page.screenshot&&page.screenshot[0]===0xff&&page.screenshot[1]===0xd8,'the capture is a JPEG');
   assert.deepEqual(leaks,[],'the page never reached the other local service');
   await assert.rejects(renderer.render(`http://127.0.0.1:${internalPort}/`),'a blocked page is not rendered');
   assert.deepEqual(leaks,[]);
 }finally{await renderer.close();await stop(site);await stop(internal);}
});

test('the trafilatura helper returns the main text and answers null for empty pages',
 {skip:!trafilaturaReady&&'Install the helper: pip install -e "scene-worker[pages]"'},async()=>{
 const extractor=new Trafilatura(python);
 try{
   const html=`<html><body><nav>Home Work Cookie settings</nav><article><h1>Orbit</h1><p>${ARTICLE}</p><p>${ARTICLE}</p></article>
     <footer>All rights reserved</footer></body></html>`;
   const [text,empty]=await Promise.all([extractor.text(html),extractor.text('')]);
   assert.match(text??'',/custom shaders/);assert.doesNotMatch(text??'',/Cookie settings|All rights reserved/);
   assert.equal(empty,null);
 }finally{extractor.close();}
});

test('the text helper client restarts a crashed helper and stops retrying one that cannot start',async()=>{
 const echo=new Trafilatura(process.execPath,['-e',`require('readline').createInterface({input:process.stdin}).on('line',line=>{
   const {id,html}=JSON.parse(line);if(html==='crash')process.exit(1);process.stdout.write(JSON.stringify({id,text:html.toUpperCase()})+'\\n');});`]);
 try{
   assert.deepEqual(await Promise.all([echo.text('a'),echo.text('b')]),['A','B']);
   assert.equal(await echo.text('crash'),null);
   assert.equal(await echo.text('c'),'C','a helper that had been working is started again');
 }finally{echo.close();}
 const missing=new Trafilatura('zenatlas-no-such-python');
 assert.equal(await missing.text('x'),null);
 assert.equal(await missing.text('y'),null);
});
