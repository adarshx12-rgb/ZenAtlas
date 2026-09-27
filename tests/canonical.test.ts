import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceKind, rankBoost} from '../src/canonical.js';
import type {Judge} from '../src/judge.js';

test('mirrors and re-upload sites are mirrors',()=>{
 for(const u of ['https://www.scribd.com/document/1/Mapreduce','https://www.researchgate.net/publication/2','https://www.academia.edu/3/MapReduce','https://www.slideshare.net/x/y'])
  assert.equal(sourceKind(u,'the Google paper that introduced MapReduce'),'mirror',u);
});

test('government, inter-governmental and original publishers are canonical',()=>{
 assert.equal(sourceKind('https://rti.dopt.gov.in/x.pdf','RTI Act 2005 full text in Hindi'),'canonical');
 assert.equal(sourceKind('https://eur-lex.europa.eu/eli/reg/2016/679/oj','GDPR right to be forgotten'),'canonical');
 assert.equal(sourceKind('https://www.fsis.usda.gov/food-safety/leftovers','cooked rice fridge'),'canonical');
 assert.equal(sourceKind('https://www.usenix.org/legacy/events/osdi04/tech/full_papers/dean/dean.pdf','mapreduce paper'),'canonical');
});

test('a host belonging to an organisation the request names is canonical; a lookalike is not',()=>{
 assert.equal(sourceKind('https://research.google.com/archive/mapreduce-osdi04.pdf','the Google paper that introduced MapReduce'),'canonical');
 assert.equal(sourceKind('https://docs.python.org/3/library/asyncio.html','python asyncio tutorial'),'canonical');
 assert.equal(sourceKind('https://pythontutorial.net/python-concurrency/asyncio','python asyncio tutorial'),null);
 assert.equal(sourceKind('https://reencle.co/blogs/news/rice','how long can cooked rice be kept'),null);
});

test('the boost reorders only within about one relevance point',()=>{
 assert.equal(rankBoost('canonical'),1.5);
 assert.equal(rankBoost('mirror'),-0.5);
 assert.equal(rankBoost(null),0);
 assert.ok(9+rankBoost('canonical')>10+rankBoost('mirror'),'a canonical 9 beats a mirror 10');
 assert.ok(7+rankBoost('canonical')<9,'a canonical 7 does not beat a plain 9');
});

test('Docs and Web reviews read canonical items first and rank them above close mirrors',async()=>{
 const {reviewResults}=await import('../src/review.js');
 const item=(url:string,title:string)=>({url,title,source_name:new URL(url).hostname,snippet:null,published:null,engine:'brave',doc_type:'pdf'});
 const items=[item('https://www.scribd.com/document/1/MapReduce','MapReduce (Scribd)'),item('https://example.edu/mr.pdf','MapReduce copy'),
  item('https://research.google.com/archive/mapreduce-osdi04.pdf','MapReduce: Simplified Data Processing')];
 let readOrder:string[]=[];
 const judge:Judge={async judge(_q,cs){return {model:'m',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:c.url!.includes('scribd')?10:9,reason:'r',momentKeys:[]}]))};}};
 const out=await reviewResults('the Google paper that introduced MapReduce',items,{noun:'documents',criteria:[],requirement:{text:'R',evidence:'E'},textPool:1,reviewPool:40,
  read:async(list:any[])=>{readOrder=list.map(x=>x.url);return new Map();},judge,keepUnjudged:false,log:()=>{}} as any);
 assert.deepEqual(readOrder,['https://research.google.com/archive/mapreduce-osdi04.pdf'],'with one read slot, the canonical copy is read');
 assert.equal(out.results[0]!.url,'https://research.google.com/archive/mapreduce-osdi04.pdf');
 assert.equal(out.results[0]!.judgement!.relevance,9,'the shown relevance is unchanged');
 assert.equal(out.results.at(-1)!.url.includes('scribd'),false,'the scribd 10 (9.5) sits above the plain 9 but below the canonical 9');
});
