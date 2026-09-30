import {test} from 'node:test';
import assert from 'node:assert/strict';
import {grounded, nameLike} from '../src/identify.js';

const material=[
 {title:'Free Solo | Official Trailer | National Geographic',description:'Alex Honnold attempts to climb El Capitan without a rope.',creator:'National Geographic'},
 {title:'Alex Honnold climbs El Capitan without ropes',description:null,creator:'Climbing Daily'},
];
test('a name is grounded only when every word of it appears in one result',()=>{
 assert.ok(grounded('Free Solo',material));
 assert.ok(grounded('Alex Honnold',material));
 assert.ok(!grounded('The Dawn Wall',material));
 assert.ok(!grounded('Free Solo Honnold Capitan Nat Geo',material));
 assert.ok(!grounded('the',material));
});
test('a name is a few words, not a whole result title',()=>{
 assert.ok(nameLike('Free Solo'));
 assert.ok(!nameLike('Free Solo | Official Trailer | National Geographic'));
 assert.ok(!nameLike('Free Solo - Alex Honnold Climbing El Capitan'));
 assert.ok(!nameLike('one two three four five six seven'));
});
