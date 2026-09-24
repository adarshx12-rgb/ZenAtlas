import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig} from './helpers.js';
import {extractPage,PageChecker} from '../src/pages.js';
import {UpstreamError} from '../src/http.js';
import type {TextExtractor} from '../src/extract.js';

const ARTICLE_HTML=`<html><head><title>Keeping WhatsApp fresh, simple and approachable</title>
 <meta property="og:type" content="article"><meta property="og:site_name" content="WhatsApp">
 <meta property="article:published_time" content="2024-05-09T16:00:00+00:00">
 <script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","datePublished":"2024-05-09","publisher":{"@type":"Organization","name":"WhatsApp"}}</script>
 </head><body><article><h1>Keeping WhatsApp fresh</h1><p>We updated the chat interface.</p></article></body></html>`;

test('page extraction reads structured metadata: type, publication date, site and publisher',()=>{
 const page=extractPage(ARTICLE_HTML);
 assert.deepEqual(page.meta,{og_type:'article',schema_types:['NewsArticle'],published:'2024-05-09',site_name:'WhatsApp',publisher:'WhatsApp'});
 assert.equal(extractPage('<title>Plain</title><p>No metadata</p>').meta,undefined,'pages without metadata carry none');
 const graph=extractPage(`<script type="application/ld+json">{"@graph":[{"@type":["WebPage"]},{"@type":"BlogPosting","datePublished":"2023-02-01T10:00:00Z"}]}</script>`);
 assert.deepEqual([graph.meta?.schema_types,graph.meta?.published],[['WebPage','BlogPosting'],'2023-02-01']);
 assert.equal(extractPage('<script type="application/ld+json">{broken</script>').meta,undefined,'malformed JSON-LD is ignored');
});

test('a byline date standing alone counts when the page declares none; dates inside sentences do not',()=>{
 const shown=extractPage(`<title>Polls</title><body><h1>Your group chats upgraded</h1><p>${'We are rolling out polls. '.repeat(100)}</p><p>August 4, 2026</p><footer>Blog</footer></body>`);
 assert.deepEqual(shown.meta,{published_text:'August 4, 2026',published:'2026-08-04'},'wherever the byline sits (here after a long article)');
 assert.equal(extractPage(`<title>x</title><span>Posted on 9 May 2024</span>`).meta?.published,'2024-05-09');
 assert.equal(extractPage(`<title>x</title><p>On March 3, 2021 we launched polls.</p>`).meta,undefined,'a date inside a sentence may refer to anything');
 assert.equal(extractPage(`<title>x</title><p>Updated March 3, 2021</p>`).meta,undefined,'an update date is not the publication date');
 assert.equal(extractPage(`<title>x</title><time datetime="2023-11-02T08:00:00Z">Nov 2</time>`).meta?.published,'2023-11-02');
 const declared=extractPage(`<meta property="article:published_time" content="2024-01-02"><p>August 4, 2026</p>`);
 assert.equal(declared.meta?.published,'2024-01-02','declared metadata wins over visible text');
});

test('a checked page carries its declared metadata to the inspectors (found missing in the first live evaluation)',async()=>{
 const transport=async(url:string)=>{
   if(new URL(url).pathname==='/robots.txt')throw new UpstreamError('upstream_failure',404);
   return {url,contentType:'text/html',text:ARTICLE_HTML};
 };
 const page=await new PageChecker(testConfig,transport as any,{}).check('https://blog.example.org/post');
 assert.deepEqual(page.meta,{og_type:'article',schema_types:['NewsArticle'],published:'2024-05-09',site_name:'WhatsApp',publisher:'WhatsApp'});
});

test('PDFs are fetched as documents and read by the text helper; without it they are not inspected',async()=>{
 const transport=async(url:string)=>{
   if(new URL(url).pathname==='/robots.txt')throw new UpstreamError('upstream_failure',404);
   throw new UpstreamError('unsupported_content');
 };
 const fetchedPdf:string[]=[];
 const binary=async(url:string)=>{fetchedPdf.push(url);return {url,contentType:'application/pdf',data:Buffer.from('%PDF-1.7 fake')};};
 const extractor:TextExtractor={async text(){return null;},close(){},
   async pdf(data:Buffer){assert.equal(data.toString(),'%PDF-1.7 fake');
     return {pages:38,title:'The Art of Seduction - Summary',author:'StoryShots',created:'2024-08-02',text:'Book summary and key takeaways of The Art of Seduction by Robert Greene.'};}};
 const checker=new PageChecker(testConfig,transport as any,{extractor},binary as any);
 const page=await checker.check('https://docs.example.org/seduction.pdf');
 assert.equal(page.status,'checked');assert.equal(page.title,'The Art of Seduction - Summary');
 assert.deepEqual(page.pdf,{pages:38,title:'The Art of Seduction - Summary',author:'StoryShots',created:'2024-08-02',
   text:'Book summary and key takeaways of The Art of Seduction by Robert Greene.'});
 assert.equal(page.meta?.content_type,'application/pdf');
 assert.deepEqual(fetchedPdf,['https://docs.example.org/seduction.pdf']);
 const blind=new PageChecker(testConfig,transport as any,{},binary as any);
 const unread=await blind.check('https://docs.example.org/other.pdf');
 assert.deepEqual([unread.status,unread.meta?.content_type,unread.pdf],['unavailable','application/pdf',undefined],'no helper: the PDF is known but not inspected');
});
