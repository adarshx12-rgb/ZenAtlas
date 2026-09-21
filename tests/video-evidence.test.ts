import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCaptions,PublicVideoEvidence,selectComments} from '../src/video-evidence.js';
import {database,fixture,testConfig} from './helpers.js';
import {importTranscript} from '../src/moments.js';
import {applySignals} from '../src/signals.js';
import {parseEmbedding} from '../src/embeddings.js';
import {evaluateRanking} from '../src/evaluation.js';
import {evidenceCeiling,type JudgeCandidate} from '../src/judge.js';

test('title-only claims cannot receive a directly verified score',()=>{
 const candidate:JudgeCandidate={key:'r1',kind:'video',site:'example.com',title:'Exact ghost twist',channel:null,official:false,duration:null,live:null,description:null,comments:[],moments:[],discussions:[]};
 assert.equal(evidenceCeiling(candidate),6);
 assert.equal(evidenceCeiling({...candidate,comments:['A viewer claims it contains a reveal']}),8);
 assert.equal(evidenceCeiling({...candidate,page:{status:'checked',title:null,description:null,text:'A video landing page',libraries:[]}}),6);
});

test('publisher captions retain time and reject malformed or out-of-duration cues',()=>{
 assert.deepEqual(parseCaptions('WEBVTT\n\n00:01.000 --> 00:03.500\nThe <b>reveal</b>.'),[{start:1,end:3.5,text:'The  reveal .'}]);
 assert.equal(parseCaptions('1\n00:00:01,000 --> 00:00:02,000\nHello')[0].end,2);
 assert.throws(()=>parseCaptions('00:03.000 --> 00:02.000\nNo'));
 assert.throws(()=>parseCaptions('00:01.000 --> 00:15.000\nNo',10));
 assert.throws(()=>parseCaptions('untimed transcript'));
});
test('comment sampling includes correction, timestamp, recent and reply evidence despite low likes',()=>{
 const comments=Array.from({length:40},(_,i)=>({id:String(i),text:'Great video!',likes:100-i}));
 const special=[{id:'a',text:'Actually this is not the reveal',likes:0},{id:'b',text:'1:20 the reveal happens',likes:0},
 {id:'c',text:'Recent context',likes:0,sample:'recent' as const},{id:'d',text:'Reply context',likes:0,sample:'reply' as const}];
 const selected=selectComments([...comments,...special],'reveal');
 for(const c of special) assert.ok(selected.includes(c.text));
});
test('unsupported and unpermitted sources never trigger inferred API requests',async()=>{
 const adapter=new PublicVideoEvidence(async()=>{throw new Error('Must not fetch');});
 assert.equal((await adapter.check('https://example.com/watch/123',{viewer_signals:true,transcripts:true})).commentStatus,'unsupported');
 assert.equal((await adapter.check('https://archive.org/details/movie',{viewer_signals:false,transcripts:false})).captionStatus,'not_permitted');
});
test('PeerTube comments survive a caption outage; valid captions carry publisher provenance',async()=>{
 const root='https://video.example/w/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
 const json=async(url:string)=>url.includes('comment-threads')?{data:[{id:7,text:'1:20 A reveal'}]}:
 url.endsWith('/captions')?{data:[{language:{id:'en'},captionPath:'/captions/en.vtt'}]}:
 {uuid:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',duration:100,commentsEnabled:true};
 const ok=new PublicVideoEvidence(json,async url=>({url,contentType:'text/vtt',text:'00:01.000 --> 00:02.000\nA ghost'}));
 const result=await ok.check(root,{viewer_signals:true,transcripts:true});
 assert.equal(result.comments.length,1);assert.equal(result.caption?.origin,'https://video.example/captions/en.vtt');
 const broken=new PublicVideoEvidence(json,async()=>{throw new Error('outage');});
 const partial=await broken.check(root,{viewer_signals:true,transcripts:true});
 assert.equal(partial.commentStatus,'available');assert.equal(partial.captionStatus,'unavailable');
});
test('Archive rejects captions on an ambiguous multi-film item',async()=>{
 const adapter=new PublicVideoEvidence(async()=>({metadata:{mediatype:'movies'},files:[
 {name:'one.mp4',source:'original'},{name:'two.mp4',source:'original'},{name:'one.srt'}],reviews:[{reviewbody:'A viewer claim'}]}),async()=>{throw Error('must not fetch caption');});
 const result=await adapter.check('https://archive.org/details/films',{viewer_signals:true,transcripts:true});
 assert.equal(result.caption,undefined);assert.equal(result.comments[0].text,'A viewer claim');
});
test('final judge receives permitted transcript passages and revocation removes them',async()=>{
 const db=await database();
 try {
   const r=await fixture(db,'A ghost story');
   await importTranscript(db,{content_id:r.id,language:'en',origin:'publisher',content_version:'v1',timing_quality:'provided',retention_permitted:true,
     segments:[{start:1,end:4,text:'The narrator was a ghost all along.'}]});
   let transcriptCount=-1;
   const judge={judge:async(_q:string,c:any[])=>{transcriptCount=c[0].transcripts.length;return {model:'test',verdicts:new Map()};}};
   await applySignals(db,testConfig,'ghost reveal',[r],{judge});assert.equal(transcriptCount,1);
   await db.query(`UPDATE sources SET policy=policy||'{"transcripts":false}'::jsonb WHERE id=$1`,[r.source_id]);
   await applySignals(db,testConfig,'ghost reveal',[r],{judge});assert.equal(transcriptCount,0);
 } finally {await db.close();}
});
test('embedding response compatibility validates dimensions and numerical content',()=>{
 assert.deepEqual(parseEmbedding({data:[{embedding:[1,2,3]}]},3),[1,2,3]);
 assert.deepEqual(parseEmbedding({embedding:[1,2]},2),[1,2]);
 assert.throws(()=>parseEmbedding({embedding:[0,0]},2));assert.throws(()=>parseEmbedding({embedding:[1]},2));
});
test('evaluation never interprets unreviewed results as irrelevant',()=>{
 assert.equal(evaluateRanking(['a','b'],new Map([['a',3],['b',null]])).ndcg,null);
 assert.equal(evaluateRanking(['a'],new Map([['a',3]])).ndcg,1);
 assert.equal(evaluateRanking(['a'],new Map([['a',3],['b',null]])).ndcg,null,'unknown ideal pool cannot produce a reliable NDCG');
});
