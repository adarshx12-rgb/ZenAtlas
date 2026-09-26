import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig} from './helpers.js';
import {searchWeb, webSearchInput, documentType} from '../src/web.js';
import {UpstreamError} from '../src/http.js';

const config={...testConfig,BRAVE_SEARCH_API_KEY:'brave-key',SEARXNG_BASE_URL:'http://searxng.test',BRAVE_MIN_RESULTS:2};
const brave=(...rows:{url:string;title?:string;description?:string}[])=>({web:{results:rows.map(r=>({title:'Title',description:'About it',...r}))},
 query:{more_results_available:true}});
const searxng=(...rows:{url:string;title?:string;content?:string}[])=>({results:rows.map(r=>({title:'Title',content:'About it',engine:'bing',...r}))});
function deps(answers:Record<string,unknown>,budget=true){
 const asked:string[]=[];
 // Every document link answers as a real PDF unless a test says otherwise.
 // Hunts are recorded, never started: a real one would search the web in the background.
 const hunts:{query:string;docs:number;explore:boolean}[]=[];
 return {asked,hunts,deps:{budget:async()=>budget,peek:async()=>({url:'',status:200,contentType:'application/pdf',length:100,head:Buffer.from('%PDF-1.4')}),
   hunt:(query:string,docs:unknown[],explore:boolean)=>{hunts.push({query,docs:docs.length,explore});return 'hunt-token';},
   sources:async()=>({docs:[],sites:[],providers:[]}),
   transport:async(url:string)=>{
   asked.push(url);const host=new URL(url).hostname;
   if(!(host in answers))throw new Error(`unexpected ${url}`);
   const answer=answers[host];if(answer instanceof Error)throw answer;return answer;
 }}};
}

test('web search asks Brave first and returns pages with host, snippet and access label',async()=>{
 const {asked,deps:d}=deps({'api.search.brave.com':brave({url:'https://example.org/guide',title:'<strong>Guide</strong>'},{url:'https://arxiv.org/abs/2401.00001',description:'I&#x27;m &amp; it&#39;s &#8212; done'})});
 const out=await searchWeb({} as any,config,webSearchInput.parse({q:'transformer guide'}),d);
 assert.equal(asked.length,1,'enough Brave results means no SearXNG call');
 assert.deepEqual(out.results.map(r=>[r.url,r.title,r.source_name,r.snippet,r.access]),
   [['https://example.org/guide','Guide','example.org','About it',null],['https://arxiv.org/abs/2401.00001','Title','arxiv.org',"I'm & it's — done",'Open access']]);
 assert.equal(out.next_cursor,'2');
});

test('shadow libraries are never served, and SearXNG fills in when Brave finds too little',async()=>{
 const {asked,deps:d}=deps({'api.search.brave.com':brave({url:'https://libgen.is/book/index.php?md5=x'},{url:'https://example.org/a'}),
   'searxng.test':searxng({url:'https://example.org/a'},{url:'https://example.net/b'},{url:'https://z-library.sk/book/1'})});
 const out=await searchWeb({} as any,config,webSearchInput.parse({q:'some book'}),d);
 assert.equal(asked.length,2);
 assert.deepEqual(out.results.map(r=>r.url),['https://example.org/a','https://example.net/b']);
});

test('Brave failing or over budget falls back to SearXNG; nothing configured says so',async()=>{
 const failing=deps({'api.search.brave.com':new Error('down'),'searxng.test':searxng({url:'https://example.org/a'})});
 assert.deepEqual((await searchWeb({} as any,config,webSearchInput.parse({q:'query'}),failing.deps)).results.map(r=>r.url),['https://example.org/a']);
 const spent=deps({'searxng.test':searxng({url:'https://example.org/a'})},false);
 const out=await searchWeb({} as any,config,webSearchInput.parse({q:'query'}),spent.deps);
 assert.ok(spent.asked.every(u=>!u.includes('brave')));assert.equal(out.results.length,0,'the shared daily budget also covers SearXNG');
 assert.ok(out.providers.some(p=>p.status==='budget_exhausted'));
 const none=await searchWeb({} as any,{...testConfig,BRAVE_SEARCH_API_KEY:'',SEARXNG_BASE_URL:''},webSearchInput.parse({q:'query'}),deps({}).deps);
 assert.equal(none.providers[0].status,'disabled');
});

test('document search restricts the query by file type and keeps only real documents',async()=>{
 const {asked,deps:d}=deps({'api.search.brave.com':brave({url:'https://uni.example.edu/notes/week1.PDF'},{url:'https://example.org/page.html'},
   {url:'https://arxiv.org/pdf/2401.00001'},{url:'https://example.org/deck.pptx?download=1'})});
 const out=await searchWeb({} as any,config,webSearchInput.parse({q:'lecture notes',kind:'docs'}),d);
 const q=new URL(asked[0]).searchParams.get('q')!;
 assert.match(q,/^lecture notes \(filetype:pdf OR filetype:docx? OR .*filetype:pptx?/);
 assert.deepEqual(out.results.map(r=>[r.url,r.doc_type]),[['https://uni.example.edu/notes/week1.PDF','pdf'],
   ['https://arxiv.org/pdf/2401.00001','pdf'],['https://example.org/deck.pptx?download=1','pptx']]);
 const slides=deps({'api.search.brave.com':brave({url:'https://example.org/a.ppt'},{url:'https://example.org/b.pdf'},{url:'https://example.org/c.pptx'})});
 const onlySlides=await searchWeb({} as any,config,webSearchInput.parse({q:'deck',kind:'docs',doc_type:'slides'}),slides.deps);
 assert.equal(new URL(slides.asked[0]).searchParams.get('q'),'deck (filetype:ppt OR filetype:pptx OR filetype:odp OR filetype:key)');
 assert.deepEqual(onlySlides.results.map(r=>r.doc_type),['ppt','pptx'],'a PDF is dropped when slides were asked for');
});

test('a GitHub viewer page is replaced by the file itself, so one click opens the document',async()=>{
 const {deps:d}=deps({'api.search.brave.com':brave({url:'https://github.com/org/repo/blob/main/docs/guide.pdf'},{url:'https://github.com/org/repo/raw/main/b.docx'})});
 const out=await searchWeb({} as any,config,webSearchInput.parse({q:'guide',kind:'docs'}),d);
 assert.deepEqual(out.results.map(r=>r.url),['https://raw.githubusercontent.com/org/repo/main/docs/guide.pdf','https://raw.githubusercontent.com/org/repo/main/b.docx']);
});

test('document type is read from the path, not the query string',()=>{
 assert.equal(documentType('https://a.example/x/report.docx'),'docx');
 assert.equal(documentType('https://a.example/report.docx.html'),null);
 assert.equal(documentType('https://a.example/view?file=report.pdf'),null);
 assert.equal(documentType('https://arxiv.org/pdf/2401.00001v2'),'pdf');
});

test('document search removes spam, dead links and pages posing as files, and starts a document hunt',async()=>{
 const {deps:d,hunts}=deps({'api.search.brave.com':brave(
   {url:'https://real.example/yearbook-2018.pdf',title:'Year Book 2018'},
   {url:'https://www.spam.example/public/default.aspx/Year%20Book%202018.pdf',title:'Year Book 2018 free'},
   {url:'https://gone.example/yearbook.pdf',title:'Year Book'},
   {url:'https://fake.example/yearbook.pdf',title:'Year Book full'},
   {url:'https://shy.example/yearbook.pdf',title:'Year Book mirror'})});
 const peek=async(url:string)=>{
   if(url.includes('gone'))throw new UpstreamError('network_error');
   if(url.includes('shy'))throw new UpstreamError('upstream_failure',403);
   return {url,status:200,contentType:'application/pdf',length:100,head:Buffer.from(url.includes('fake')?'<!DOCTYPE html>':'%PDF-1.7')};
 };
 const out=await searchWeb({} as any,config,webSearchInput.parse({q:'year book 2018',kind:'docs'}),{...d,peek});
 assert.deepEqual(out.results.map(r=>[r.url,r.check]),[['https://real.example/yearbook-2018.pdf','checked'],['https://shy.example/yearbook.pdf','blocked']]);
 assert.match(out.providers.find(p=>p.provider==='document_check')!.message,/3 links were removed: 1 dead or unreachable, 1 not actually documents, 1 spam/);
 assert.equal(out.hunt,'hunt-token');
 assert.deepEqual(hunts,[{query:'year book 2018',docs:2,explore:true}],'the first page explores websites too');
 await searchWeb({} as any,config,webSearchInput.parse({q:'year book 2018',kind:'docs',page:2}),{...d,peek});
 assert.deepEqual(hunts[1],{query:'year book 2018',docs:2,explore:false},'later pages only review their own documents');
 const web=await searchWeb({} as any,config,webSearchInput.parse({q:'year book'}),{...d,peek:async()=>{throw new Error('pages are not probed');}});
 assert.equal(web.hunt,undefined,'web results are not verified or hunted');
 assert.equal(hunts.length,2);
});
