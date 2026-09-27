import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aiGenerated,excludesAI,wantsLicense,openverseResults,licenseLabel} from '../src/image-signals.js';
import {reviewImages} from '../src/image-review.js';
import type {Judge} from '../src/judge.js';
import type {ImageResult} from '../src/images.js';
import {testConfig} from './helpers.js';

test('AI-generated images are recognised from their source, not their pixels',()=>{
 assert.ok(aiGenerated('https://www.freepik.com/premium-ai-image/red-bicycle_160236855.htm','Red bicycle'));
 assert.ok(aiGenerated('https://www.rawpixel.com/image/12920184/mount-everest-generated-image-rawpixel','Everest'));
 assert.ok(aiGenerated('https://stock.adobe.com/images/x/123','Bicycle by a wall, Generative AI'));
 assert.ok(!aiGenerated('https://unsplash.com/photos/red-vintage-bicycle-leaning-against-a-blue-wall-lQh76MKnY6g','Red vintage bicycle'));
 assert.ok(!aiGenerated('https://example.com/raising-a-child','Parenting tips'),'"ai" inside a word is not a signal');
});

test('the request says when AI images are excluded and when a licence matters',()=>{
 assert.ok(excludesAI("infographic showing india's population by state, not AI-generated"));
 assert.ok(excludesAI('no ai art, real photos of cats'));
 assert.ok(!excludesAI('ai generated art of cats'));
 assert.ok(wantsLicense('free to use photo of mount everest with license and attribution'));
 assert.ok(wantsLicense('creative commons photo of a tiger'));
 assert.ok(!wantsLicense('red vintage bicycle leaning against a blue wall'));
});

test('Openverse results carry their licence, creator and attribution',()=>{
 const [r]=openverseResults({results:[{id:'a1',title:'Everest from Kala Patthar',url:'https://upload.wikimedia.org/e.jpg',thumbnail:'https://api.openverse.org/v1/images/a1/thumb/',
  foreign_landing_url:'https://commons.wikimedia.org/wiki/File:E.jpg',creator:'Pavel Novak',license:'by-sa',license_version:'2.5',
  license_url:'https://creativecommons.org/licenses/by-sa/2.5/',attribution:'"Everest" by Pavel Novak is licensed under CC BY-SA 2.5.',source:'wikimedia',width:1200,height:800}]});
 assert.equal(r!.page_url,'https://commons.wikimedia.org/wiki/File:E.jpg');
 assert.deepEqual(r!.license,{name:'CC BY-SA 2.5',url:'https://creativecommons.org/licenses/by-sa/2.5/',creator:'Pavel Novak',
  attribution:'"Everest" by Pavel Novak is licensed under CC BY-SA 2.5.'});
 assert.equal(licenseLabel('cc0',''),'CC0');
 assert.equal(licenseLabel('pdm',''),'Public domain');
 assert.equal(openverseResults({nonsense:true}).length,0);
});

const img=(id:string,title:string,extra:Partial<ImageResult>={}):ImageResult=>({id,title,image_url:`https://i.example/${id}.jpg`,thumbnail:`https://i.example/${id}-t.jpg`,
 page_url:`https://p.example/${id}`,source_name:'p.example',width:null,height:null,engine:'bing images',...extra});

test('the judge sees each image and keeps only what it shows; ranking follows its scores',async()=>{
 const seen:number[]=[];
 const judge:Judge={async judge(_q,cs,_ctx,shots){seen.push(shots?.size??0);
  return {model:'m',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:c.title==='Blue wall bicycle'?9:c.title==='Car'?2:6,reason:`r ${c.title}`,momentKeys:[]}]))};}};
 const out=await reviewImages({} as any,testConfig,'red bicycle against a blue wall',[img('a','Maybe bicycle'),img('b','Car'),img('c','Blue wall bicycle')],
  {judge,strong:null,thumbnail:async()=>({contentType:'image/jpeg',data:Buffer.from('jpg')}),log:()=>{}});
 assert.ok(seen.reduce((a,b)=>a+b,0)===3,'every thumbnail went to the judge');
 assert.deepEqual(out.results.map(r=>r.id),['c','a']);
 assert.equal(out.results[0]!.judgement!.relevance,9);
 assert.equal(out.removed,1);
});

test('an image whose thumbnail cannot be fetched or is not a JPEG is judged on its title and marked unseen',async()=>{
 let shots=-1;
 const judge:Judge={async judge(_q,cs,_ctx,s){shots=s?.size??0;return {model:'m',verdicts:new Map(cs.map(c=>[c.key,{key:c.key,relevance:7,reason:'r',momentKeys:[]}]))};}};
 const out=await reviewImages({} as any,testConfig,'q',[img('a','A'),img('b','B')],{judge,strong:null,
  thumbnail:async(u:string)=>u.includes('a-t')?{contentType:'image/png',data:Buffer.from('png')}:Promise.reject(new Error('404')),log:()=>{}});
 assert.equal(shots,0);
 assert.ok(out.results.every(r=>r.unseen));
});
