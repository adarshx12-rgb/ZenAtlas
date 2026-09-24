import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspect,decide,coverage,detectFormat,type Finding} from '../src/evidence.js';
import {normaliseContract,rulesContract,type RequirementsContract} from '../src/requirements.js';
import type {PageEvidence} from '../src/pages.js';

const DAY='2026-09-24';
const page=(p:Partial<PageEvidence>):PageEvidence=>({status:'checked',title:null,description:null,text:null,libraries:[],badges:[],...p});
const whatsapp=normaliseContract('official whatsapp chat ui interface from over past 3 years',DAY,{
 entities:[{name:'WhatsApp',kind:'product'}],official_domains:['whatsapp.com'],
 requirements:[{text:'Shows the chat interface',kind:'subject',hardness:'hard',scope:'each',evidence:'UI shown'}]});
const req=(c:RequirementsContract,kind:string)=>c.requirements.find(r=>r.kind===kind&&r.scope==='each')!;
const status=(findings:Finding[],id:string)=>findings.find(f=>f.requirement_id===id);

test('format comes from what was retrieved: a video cannot satisfy an article-only request',()=>{
 const roswell=rulesContract('rosswell ufo incident real article',DAY);const f=req(roswell,'format').id;
 const video=inspect(roswell,{url:'https://www.youtube.com/watch?v=abc123',title:'Roswell: The First Reports',description:null});
 assert.deepEqual([status(video,f)?.status,status(video,f)?.provisional],['contradicted',false]);
 const article=inspect(roswell,{url:'https://www.smithsonianmag.com/history/roswell',title:'What really happened at Roswell',description:null,
   page:page({title:'What really happened at Roswell',meta:{og_type:'article',schema_types:['NewsArticle']}})});
 assert.deepEqual([status(article,f)?.status,status(article,f)?.method,status(article,f)?.excerpt],['supported','page_fetch','NewsArticle']);
 const plain=inspect(roswell,{url:'https://example.org/roswell',title:'Roswell',description:null,page:page({title:'Roswell'})});
 assert.equal(status(plain,f)?.status,'unknown','an undeclared page is not proof of either format');
 assert.equal(detectFormat('https://example.org/x.pdf',undefined).format,'pdf');
});

test('official status needs the domain and the page naming its owner; a domain alone stays provisional',()=>{
 const a=req(whatsapp,'authority').id;
 const named=inspect(whatsapp,{url:'https://blog.whatsapp.com/chat-themes',title:'Chat themes',description:null,
   page:page({title:'Chat themes to reflect your style',meta:{site_name:'WhatsApp',published:'2025-02-13'}})});
 assert.deepEqual([status(named,a)?.status,status(named,a)?.provisional,status(named,a)?.excerpt],['supported',false,'WhatsApp']);
 const bare=inspect(whatsapp,{url:'https://faq.whatsapp.com/123',title:'Help',description:null});
 assert.deepEqual([status(bare,a)?.status,status(bare,a)?.provisional],['supported',true]);
 const other=inspect(whatsapp,{url:'https://www.theverge.com/whatsapp-redesign',title:'WhatsApp redesign',description:null,
   page:page({title:'WhatsApp is getting a redesign',meta:{site_name:'The Verge'}})});
 assert.equal(status(other,a)?.status,'unknown','a third-party page is unconfirmed, never contradicted');
 const dotcom=inspect(whatsapp,{url:'https://blog.whatsapp.com/polls',title:'x',description:null,page:page({title:'Polls',meta:{site_name:'WhatsApp.com'}})});
 assert.deepEqual([status(dotcom,a)?.status,status(dotcom,a)?.excerpt],['supported','WhatsApp.com'],'a domain suffix in the declared name is ignored');
 const ruled=rulesContract('official whatsapp chat ui',DAY),ra=ruled.requirements.find(r=>r.kind==='authority')!.id;
 const onHost=inspect(ruled,{url:'https://blog.whatsapp.com/polls',title:'x',description:null,page:page({title:'Polls',meta:{site_name:'WhatsApp.com'}})});
 assert.deepEqual([status(onHost,ra)?.status,status(onHost,ra)?.provisional],['supported',false],'without model domains, the declared publisher still counts');
 const fan=inspect(whatsapp,{url:'https://whatsapp-tips.example.org/ui',title:'WhatsApp UI',description:null,page:page({title:'WhatsApp UI',meta:{site_name:'WhatsApp Tips'}})});
 assert.equal(status(fan,a)?.status,'unknown','a site calling itself "WhatsApp Tips" is not WhatsApp');
 const newsroom=inspect(whatsapp,{url:'https://about.fb.com/news/whatsapp',title:'x',description:null,page:page({title:'x',meta:{publisher:'WhatsApp Newsroom'}})});
 assert.deepEqual([status(newsroom,a)?.status,status(newsroom,a)?.provisional],['supported',false],'a page whose declared publisher is WhatsApp is official');
 const channel=inspect(whatsapp,{url:'https://www.youtube.com/watch?v=x',title:'x',description:null,video:{publishedAt:'2024-03-01T00:00:00Z',official:true,channel:'WhatsApp'}});
 assert.deepEqual([status(channel,a)?.status,status(channel,a)?.method],['supported','video_api'],'an allow-listed official channel counts');
});

test('dates need evidence: inside the window supports, outside contradicts, missing is unknown, snippets are provisional',()=>{
 const d=req(whatsapp,'date').id;
 const inside=inspect(whatsapp,{url:'https://blog.whatsapp.com/a',title:'a',description:null,page:page({meta:{published:'2024-05-09'}})});
 const outside=inspect(whatsapp,{url:'https://blog.whatsapp.com/b',title:'b',description:null,page:page({meta:{published:'2019-01-10'}})});
 const missing=inspect(whatsapp,{url:'https://blog.whatsapp.com/c',title:'c',description:null,page:page({})});
 const snippet=inspect(whatsapp,{url:'https://blog.whatsapp.com/d',title:'d',description:null,published_at:'2024-01-01T00:00:00Z'});
 assert.deepEqual([status(inside,d)?.status,status(inside,d)?.excerpt],['supported','2024-05-09']);
 assert.equal(status(outside,d)?.status,'contradicted');
 assert.equal(status(missing,d)?.status,'unknown');
 assert.deepEqual([status(snippet,d)?.status,status(snippet,d)?.provisional],['supported',true]);
 const set=whatsapp.requirements.find(r=>r.scope==='set')!;
 assert.deepEqual(inside.filter(f=>f.requirement_id===set.id).map(f=>[f.status,f.location.key]),[['supported','2024']]);
});

test('inaccessible pages leave requirements unknown and record why',()=>{
 const roswell=rulesContract('rosswell ufo incident real article',DAY);const f=req(roswell,'format').id;
 const blocked=inspect(roswell,{url:'https://news.example.org/roswell',title:'Roswell',description:null,page:page({status:'robots_disallowed'})});
 assert.deepEqual([status(blocked,f)?.status,status(blocked,f)?.access],['unknown','robots_disallowed']);
 const down=inspect(roswell,{url:'https://news.example.org/r2',title:'Roswell',description:null,page:page({status:'unavailable'})});
 assert.deepEqual([status(down,f)?.status,status(down,f)?.access],['unknown','unavailable']);
 assert.notEqual(decide(roswell,blocked).status,'excluded','an inaccessible page is never excluded for it');
});

test('a book summary cannot qualify as the full book; a legitimate store page can',()=>{
 const book=normaliseContract('robert greene art of seduction pdf',DAY,{completeness:'full',entities:[{name:'The Art of Seduction',kind:'work'}]});
 const full=req(book,'completeness').id,fmt=req(book,'format').id;
 const summary=inspect(book,{url:'https://docs.example.org/seduction.pdf',title:'The Art of Seduction',description:null,
   page:page({title:'The Art of Seduction - Summary',text:'Book summary and key takeaways of The Art of Seduction by Robert Greene.',
     meta:{content_type:'application/pdf'},pdf:{pages:38,title:'The Art of Seduction - Summary',author:'StoryShots',created:'2024-08-02',text:'Book summary and key takeaways'}})});
 assert.deepEqual([status(summary,full)?.status,status(summary,fmt)?.status],['contradicted','supported']);
 assert.match(status(summary,full)!.excerpt!,/Summary/);
 assert.equal(decide(book,summary).status,'excluded');
 const store=inspect(book,{url:'https://www.penguinrandomhouse.com/books/331432/the-art-of-seduction-by-robert-greene/',title:'The Art of Seduction',description:null,
   page:page({title:'The Art of Seduction by Robert Greene | PenguinRandomHouse.com: Books'})});
 assert.deepEqual([status(store,full)?.status,status(store,full)?.excerpt],['supported','Buy']);
 const decision=decide(book,store);
 assert.equal(decision.status,'verified','a legitimate full copy is shown even though it is not a PDF');
 assert.ok(decision.notes.some(n=>/not as PDF/i.test(n)));
 const upload=inspect(book,{url:'https://www.scribd.com/document/757161093/The-Art-of-Seduction-Robert-Greene',title:'The Art of Seduction',description:null,
   page:page({title:'The Art of Seduction - Robert Greene',meta:{content_type:'application/pdf'},pdf:{pages:460,title:'The Art of Seduction',author:null,created:null,text:'Preface'}})});
 assert.equal(status(upload,full)?.status,'unknown','a user upload of a commercial work never counts as legitimate access');
 const pirate=inspect(book,{url:'https://oceanofpdf.com/pdf-the-art-of-seduction/',title:'The Art of Seduction PDF',description:null});
 assert.equal(status(pirate,full)?.status,'contradicted');
});

test('decisions: inspected contradictions exclude, all-supported verifies, anything unknown stays uncertain; inspected beats predicted',()=>{
 const roswell=rulesContract('rosswell ufo incident real article',DAY);const f=req(roswell,'format').id;
 const video=inspect(roswell,{url:'https://www.youtube.com/watch?v=abc',title:'Roswell',description:null});
 assert.equal(decide(roswell,video,[{id:f,status:'supported',field:'title',quote:'Roswell'}]).status,'excluded','the judge cannot overrule the inspected format');
 const article=inspect(roswell,{url:'https://www.time.com/roswell',title:'Roswell',description:null,page:page({meta:{og_type:'article'}})});
 assert.equal(decide(roswell,article).status,'verified');
 const unknown=inspect(roswell,{url:'https://example.org/r',title:'Roswell',description:null});
 const d=decide(roswell,unknown);
 assert.deepEqual([d.status,d.unconfirmed],['uncertain',[f]]);
 assert.equal(decide(roswell,unknown,[{id:f,status:'supported',field:'title',quote:'Roswell'}]).status,'uncertain',
   'a model quoting a title cannot establish a format; only inspection can');
 const topic=normaliseContract('roswell ufo incident article',DAY,{requirements:[{text:'About the 1947 incident',kind:'subject',hardness:'hard',scope:'each',evidence:'describes it'}]});
 const s=topic.requirements.find(r=>r.kind==='subject')!.id;
 const read=inspect(topic,{url:'https://www.time.com/roswell',title:'Roswell',description:null,page:page({meta:{og_type:'article'}})});
 assert.equal(decide(topic,read,[{id:s,status:'supported',field:'page',quote:'debris'}]).status,'verified','subject evidence comes from the judge\'s grounded quote');
 assert.equal(decide(topic,read,[{id:s,status:'mismatch',field:'page',quote:'weather balloon'}]).status,'excluded','a grounded judge mismatch on a subject still excludes');
});

test('coverage separates per-result requirements from set requirements and names the gaps',()=>{
 const found=(url:string,day:string)=>inspect(whatsapp,{url,title:'x',description:null,page:page({title:'Chat',meta:{site_name:'WhatsApp',published:day}})});
 const cov=coverage(whatsapp,[...found('https://blog.whatsapp.com/1','2024-05-09'),...found('https://blog.whatsapp.com/2','2025-02-13')],2);
 const set=whatsapp.requirements.find(r=>r.scope==='set')!;
 assert.deepEqual(cov.gaps.filter(g=>g.requirement_id===set.id).map(g=>g.item),['2023','2026']);
 const date=req(whatsapp,'date').id;
 assert.equal(cov.each.find(e=>e.id===date)?.supported,2);
 assert.ok(!cov.gaps.some(g=>g.requirement_id===date),'two supported results meet a target of two');
 assert.ok(cov.gaps.some(g=>g.requirement_id===req(whatsapp,'subject').id),'subject evidence comes only from the judge, so it is still a gap');
});
