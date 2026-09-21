import {test} from 'node:test';
import assert from 'node:assert/strict';
import {providerBudget} from '../src/budgets.js';
import {testConfig} from './helpers.js';

test('each metered discovery provider spends its own daily limit',()=>{
 assert.equal(providerBudget(testConfig,'brave'),250,'Brave defaults to 250 requests a day');
 assert.equal(providerBudget({...testConfig,BRAVE_DAILY_BUDGET:40},'brave'),40,'and follows its own setting, not the shared one');
 assert.equal(providerBudget({...testConfig,DISCOVERY_DAILY_BUDGET:7},'brave'),250,'raising or lowering the shared limit leaves Brave alone');
 assert.equal(providerBudget(testConfig,'google'),testConfig.DISCOVERY_DAILY_BUDGET);
 assert.equal(providerBudget(testConfig,'searxng'),testConfig.SEARXNG_DAILY_BUDGET);
});
