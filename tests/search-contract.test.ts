import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contractModels} from '../src/search-contract.js';
import {testConfig} from './helpers.js';

test('contracts are drafted by the fast model, not the slow planner list (8 Oct: the planner missed its time limit on 11 of 12 searches)', () => {
 const config = {...testConfig, PLANNER_MODELS: 'openai/gpt-6-luna,google/gemma-4-31b-it', QUERY_REWRITE_MODEL: 'google/gemini-3.5-flash-lite'};
 assert.deepEqual(contractModels({...config, CONTRACT_MODELS: ''}), ['google/gemini-3.5-flash-lite']);
 assert.deepEqual(contractModels({...config, CONTRACT_MODELS: 'a/one, b/two'}), ['a/one', 'b/two']);
 assert.deepEqual(contractModels({...config, CONTRACT_MODELS: '', QUERY_REWRITE_MODEL: ''}), []);
});
