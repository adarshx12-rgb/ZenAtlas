import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {testConfig} from './helpers.js';
import {PDFDocument} from 'pdf-lib';
import {DocumentPreviews, PreviewError, previewToken} from '../src/doc-preview.js';

async function pdfOf(pages:number){const doc=await PDFDocument.create();for(let i=0;i<pages;i++)doc.addPage([200,200]);return Buffer.from(await doc.save());}
const PDF=await pdfOf(2),LONG=await pdfOf(12);
const DOCX=Buffer.concat([Buffer.from('PK\x03\x04'),Buffer.alloc(64)]);
const HTML=Buffer.from('<!doctype html><title>Download</title>');

async function setup(files:Record<string,Buffer|Error>,{converter='soffice',budget=true,pages=5}={}){
 const dir=await mkdtemp(join(tmpdir(),'zenatlas-preview-test-'));
 const fetched:string[]=[],converted:string[]=[];
 const config={...testConfig,DOC_PREVIEW_CACHE_DIR:dir,DOC_PREVIEW_CONVERTER:converter,DOC_PREVIEW_PAGES:pages};
 const previews=new DocumentPreviews({} as any,config,{
   fetch:async(url:string)=>{fetched.push(url);const f=files[url];if(!f)throw new Error('404');if(f instanceof Error)throw f;return {url,contentType:'application/octet-stream',data:f};},
   convert:async(input:string,ext:string)=>{converted.push(ext);return PDF;},
   budget:async()=>budget});
 const get=(url:string,token=previewToken(config.SESSION_SECRET,url))=>previews.get(url,token);
 return {dir,fetched,converted,get,cleanup:()=>rm(dir,{recursive:true,force:true})};
}

test('a signed PDF link is fetched once, served as PDF and then answered from the cache',async()=>{
 const s=await setup({'https://uni.example.edu/notes.pdf':PDF});
 try{
   const first=await s.get('https://uni.example.edu/notes.pdf');
   assert.deepEqual([first.pages,first.shown],[2,2]);assert.deepEqual(first.pdf,PDF,'a short PDF is served as it is');
   assert.deepEqual(await s.get('https://uni.example.edu/notes.pdf'),first);
   assert.equal(s.fetched.length,1);assert.equal(s.converted.length,0,'PDFs are served as they are');
 }finally{await s.cleanup();}
});

test('office documents are converted to PDF; without a converter they are refused plainly',async()=>{
 const s=await setup({'https://example.org/deck.pptx':DOCX});
 try{assert.equal((await s.get('https://example.org/deck.pptx')).pages,2);assert.deepEqual(s.converted,['pptx']);}
 finally{await s.cleanup();}
 const none=await setup({'https://example.org/deck.pptx':DOCX},{converter:''});
 try{await assert.rejects(none.get('https://example.org/deck.pptx'),(e:any)=>e instanceof PreviewError&&e.code==='preview_unsupported');
   assert.equal(none.fetched.length,0,'nothing is downloaded that cannot be shown');}
 finally{await none.cleanup();}
});

test('unsigned, non-document and shadow-library links are refused before any fetch',async()=>{
 const s=await setup({});
 try{
   const code=(p:Promise<unknown>)=>p.then(()=>'ok',(e:any)=>e.code);
   assert.equal(await code(s.get('https://example.org/a.pdf','forged-token-value')),'preview_forbidden');
   assert.equal(await code(s.get('https://example.org/page.html')),'preview_unsupported');
   assert.equal(await code(s.get('https://libgen.is/book/a.pdf')),'preview_forbidden');
   assert.equal(await code(s.get('https://example.org/book.epub')),'preview_unsupported');
   assert.equal(s.fetched.length,0);
 }finally{await s.cleanup();}
});

test('a download that is not the promised document, a failed fetch or a spent budget is reported, not cached',async()=>{
 const s=await setup({'https://example.org/fake.pdf':HTML,'https://example.org/gone.pdf':new Error('down')});
 try{
   const code=(p:Promise<unknown>)=>p.then(()=>'ok',(e:any)=>e.code);
   assert.equal(await code(s.get('https://example.org/fake.pdf')),'preview_mismatch');
   assert.equal(await code(s.get('https://example.org/gone.pdf')),'preview_unavailable');
   assert.deepEqual((await readdir(s.dir)).filter(f=>f.endsWith('.pdf')),[]);
 }finally{await s.cleanup();}
 const spent=await setup({'https://example.org/a.pdf':PDF},{budget:false});
 try{assert.equal(await spent.get('https://example.org/a.pdf').then(()=>'ok',(e:any)=>e.code),'preview_budget');}
 finally{await spent.cleanup();}
});

test('the preview is the first pages only; the whole document stays at its source',async()=>{
 const s=await setup({'https://example.org/long.pdf':LONG});
 try{
   const preview=await s.get('https://example.org/long.pdf');
   assert.deepEqual([preview.pages,preview.shown],[12,5]);
   assert.equal((await PDFDocument.load(preview.pdf)).getPageCount(),5);
   const cached=await s.get('https://example.org/long.pdf');assert.deepEqual([cached.pages,cached.shown],[12,5],'the cache remembers the full length');
 }finally{await s.cleanup();}
 const whole=await setup({'https://example.org/long.pdf':LONG},{pages:0});
 try{assert.equal((await whole.get('https://example.org/long.pdf')).shown,12,'0 previews every page');}
 finally{await whole.cleanup();}
});
