import {test} from 'node:test';
import assert from 'node:assert/strict';
import {linkPotential, requirementTerms, creatorNames} from '../src/link-potential.js';

const screen = (promising: number, uncertain: number, mismatch: number, choice: 'promising'|'uncertain'|'mismatch' = 'uncertain', confidence = 0.5) =>
 ({choice, confidence, probabilities: {promising, uncertain, mismatch}});

test('link potential starts from the screener and defaults without one', () => {
 assert.equal(linkPotential({screen: screen(0.6, 0.2, 0.2), creators: [], comments: [], terms: []}).value, 0.7);
 assert.equal(linkPotential({creators: [], comments: [], terms: []}).value, 0.3);
});

test('the named creator and a matching comment raise it; a confident mismatch caps it; it stays in [0,1]', () => {
 const base = {screen: screen(0.2, 0.4, 0.4), comments: [] as string[], terms: ['subscriber', 'playstation']};
 const creator = linkPotential({...base, channel: 'MrBeast', creators: ['Mr Beast']});
 assert.equal(creator.creator, true);
 assert.ok(Math.abs(creator.value - 0.6) < 1e-9);
 assert.equal(linkPotential({...base, channel: 'MrBeast Gaming', creators: ['MrBeast']}).creator, false, 'another channel of the same brand is not the creator');
 assert.equal(linkPotential({...base, creators: [], comments: ['he gave the PlayStation to a subscriber!']}).comment, true);
 assert.equal(linkPotential({...base, creators: [], comments: ['a subscriber here']}).comment, false, 'one shared term is not enough');
 const bad = linkPotential({screen: screen(0.05, 0.05, 0.9, 'mismatch', 0.9), channel: 'MrBeast', creators: ['MrBeast'], comments: [], terms: []});
 assert.equal(bad.capped, true); assert.equal(bad.value, 0.1);
 assert.equal(linkPotential({screen: screen(1, 0, 0), channel: 'A1b', creators: ['A1b'], comments: ['subscriber playstation'], terms: ['subscriber', 'playstation']}).value, 1);
});

test('requirement terms and creator names come from the contract', () => {
 const contract: any = {entities: [{kind: 'person', name: 'MrBeast'}, {kind: 'product', name: 'PS5'}],
   requirements: [{id: 'R1', text: 'MrBeast buys ps5', evidence: 'Video shows MrBeast presenting a PS5 console', hardness: 'hard', scope: 'each', kind: 'subject'},
     {id: 'R2', text: 'soft thing', evidence: 'ignored', hardness: 'preferred', scope: 'each', kind: 'subject'}]};
 assert.deepEqual(creatorNames(contract), ['MrBeast']);
 const terms = requirementTerms(contract, 'mr beast buys ps5');
 assert.ok(terms.includes('console') && terms.includes('mrbeast') && !terms.includes('ignored'));
 assert.deepEqual(requirementTerms(undefined, 'find the cooking video'), ['find', 'cooking']);
});
