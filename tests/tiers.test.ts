import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig} from './helpers.js';
import {tierConfig, tierSchema} from '../src/tiers.js';

const base={...testConfig,JUDGE_MODELS:'google/gemini-3.5-flash-lite,google/gemini-3.8-flash',
 COUNCIL_CHECKER_MODELS:'openai/gpt-5.6-terra,openai/gpt-5.4-mini',COUNCIL_CHAIR_MODELS:'anthropic/claude-sonnet-5',
 CRITIC_MODEL:'anthropic/claude-sonnet-5',CRITIC_REVIEW_MODEL:'anthropic/claude-sonnet-5',
 MODE_ROUTER_MODEL:'google/gemini-3.5-flash-lite',QUERY_REWRITE_MODEL:'google/gemini-3.5-flash-lite'};

test('ssj3 is the configuration exactly as it is today',()=>{
 assert.equal(tierConfig(base,'ssj3'),base);
 assert.equal(base.TIER,'ssj3');
});

test('ssj1 swaps only the model settings, with the ssj3 models kept as backups',()=>{
 const c=tierConfig(base,'ssj1');
 assert.equal(c.TIER,'ssj1');
 assert.equal(c.JUDGE_MODELS,'google/gemini-2.5-flash-lite,google/gemini-3.5-flash-lite,google/gemini-3.8-flash');
 assert.equal(c.COUNCIL_CHECKER_MODELS,'openai/gpt-5.6-luna,openai/gpt-5.6-terra,openai/gpt-5.4-mini');
 assert.equal(c.COUNCIL_CHAIR_MODELS,'anthropic/claude-haiku-4.5,anthropic/claude-sonnet-5');
 assert.deepEqual([c.CRITIC_MODEL,c.CRITIC_REVIEW_MODEL,c.MODE_ROUTER_MODEL,c.QUERY_REWRITE_MODEL],
   ['anthropic/claude-haiku-4.5','anthropic/claude-haiku-4.5','openai/gpt-4.1-nano','openai/gpt-4.1-nano']);
 const changed=Object.keys(base).filter(k=>(base as any)[k]!==(c as any)[k]).sort();
 assert.deepEqual(changed,['ANSWER_VERIFIER_MODELS','ANSWER_WRITER_MODELS','CASCADE_STRONG_MODELS','COUNCIL_CHAIR_MODELS','COUNCIL_CHECKER_MODELS','CRITIC_MODEL','CRITIC_REVIEW_MODEL','JUDGE_MODELS',
   'MODE_ROUTER_MODEL','QUERY_REWRITE_MODEL','TIER']);
 assert.equal(c.PLANNER_MODELS,base.PLANNER_MODELS);assert.equal(c.GEMINI_MODEL,base.GEMINI_MODEL);assert.equal(c.JEV_MODEL,base.JEV_MODEL);
});

test('an SSJ1 model already in the ssj3 list is not repeated; a changed SSJ1 setting is used',()=>{
 const c=tierConfig({...base,SSJ1_JUDGE_MODELS:'google/gemini-3.8-flash'},'ssj1');
 assert.equal(c.JUDGE_MODELS,'google/gemini-3.8-flash,google/gemini-3.5-flash-lite');
});

test('the tier input: ssj1 or ssj3; anything missing or unknown means ssj3, never an error',()=>{
 assert.equal(tierSchema.parse(undefined),'ssj3');
 assert.equal(tierSchema.parse('ssj1'),'ssj1');
 assert.equal(tierSchema.parse('ssj2'),'ssj3');
 assert.equal(tierSchema.parse('SSJ1'),'ssj3');
});

import {searchInput} from '../src/types.js';
import {queryKey} from '../src/search.js';
import {webSearchInput} from '../src/web.js';

test('searches carry their tier; ssj3 reuse keys are today\'s and ssj1 keys differ',()=>{
 const today=searchInput.parse({q:'underrated osint tools'});
 assert.equal(today.tier,'ssj3');
 const {tier:_t,...withoutTier}=today;
 assert.equal(queryKey(today),queryKey(withoutTier as any),'ssj3 keeps the key existing jobs were stored under');
 assert.notEqual(queryKey(searchInput.parse({q:'underrated osint tools',tier:'ssj1'})),queryKey(today));
 assert.equal(webSearchInput.parse({q:'x y',tier:'ssj1'}).tier,'ssj1');
 assert.equal(webSearchInput.parse({q:'x y',tier:'max'}).tier,'ssj3');
 assert.equal(searchInput.parse({q:'x y',tier:'retired-tier'}).tier,'ssj3');
});
