import {test} from 'node:test';
import assert from 'node:assert/strict';
import {earlyScenePicks} from '../src/scene-early.js';
import type {Result} from '../src/types.js';
import type {ScreenSignal} from '../src/link-potential.js';

const r=(id:string,url:string)=>({id,canonical_url:url,title:id} as unknown as Result);
const screen=(choice:ScreenSignal['choice'],confidence:number):ScreenSignal=>({choice,confidence,probabilities:{promising:choice==='promising'?confidence:0.1,uncertain:0.1,mismatch:choice==='mismatch'?confidence:0.1}});
const results=[r('a','https://www.youtube.com/watch?v=aaaaaaaaaaa'),r('b','https://www.youtube.com/watch?v=bbbbbbbbbbb'),
 r('c','https://www.youtube.com/watch?v=ccccccccccc'),r('d','https://vimeo.com/123'),r('e','https://www.youtube.com/watch?v=eeeeeeeeeee')];
const screens=new Map<string,ScreenSignal>([[results[0].canonical_url,screen('promising',0.9)],[results[1].canonical_url,screen('promising',0.95)],
 [results[2].canonical_url,screen('promising',0.5)],[results[3].canonical_url,screen('promising',0.99)],[results[4].canonical_url,screen('uncertain',0.9)]]);
const value:Record<string,number>={a:0.6,b:0.9,c:0.99,d:1,e:0.8};
const link=(x:Result)=>({value:value[x.id],base:0,creator:false,comment:false,capped:false});

test('early scene picks are confident promising YouTube videos, best link potential first, up to the limit',()=>{
 assert.deepEqual(earlyScenePicks(results,screens,link,2,0.8).map(x=>x.id),['b','a']);
 assert.deepEqual(earlyScenePicks(results,screens,link,1,0.8).map(x=>x.id),['b']);
 assert.deepEqual(earlyScenePicks(results,screens,link,0,0.8),[]);
});

test('without screening there are no early picks',()=>{
 assert.deepEqual(earlyScenePicks(results,undefined,link,2,0.8),[]);
});
