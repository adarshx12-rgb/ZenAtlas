import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DRAFT_REQUIRED,DRAFT_SCHEMA,explicitFormats,hardEach,normaliseContract,resolveDates,rulesContract,setRequirements} from '../src/requirements.js';

const DAY='2026-09-24';

test('relative publication windows resolve against the search date; bare event years do not become windows',()=>{
 assert.deepEqual(resolveDates('official whatsapp chat ui interface from over past 3 years',DAY),{text:'past 3 years',from:'2023-09-24',to:DAY});
 assert.deepEqual(resolveDates('news last year',DAY),{text:'last year',from:'2025-01-01',to:'2025-12-31'});
 assert.deepEqual(resolveDates('reviews since 2021',DAY),{text:'since 2021',from:'2021-01-01',to:DAY});
 assert.deepEqual(resolveDates('launches 2021 to 2022',DAY)?.from,'2021-01-01');
 assert.equal(resolveDates('roswell 1947 incident',DAY),null,'an event year is subject matter, not a publication window');
});

test('formats come only from words the user wrote',()=>{
 assert.deepEqual(explicitFormats('rosswell ufo incident real article'),['article']);
 assert.deepEqual(explicitFormats('robert greene art of seduction pdf'),['pdf']);
 assert.deepEqual(explicitFormats('yeti footage'),['video']);
 assert.deepEqual(explicitFormats('roswell ufo incident'),[],'no format is invented for a bare topic');
});

test('the WhatsApp request needs official status and dates for each result, and year coverage across the set',()=>{
 const c=normaliseContract('official whatsapp chat ui interface from over past 3 years',DAY,{
   intent:'Show the official WhatsApp chat interface as it changed over the past three years',
   entities:[{name:'WhatsApp',kind:'product'}],official_domains:['https://blog.whatsapp.com/','whatsapp.com'],
   requirements:[{text:'Shows the chat interface',kind:'subject',hardness:'hard',scope:'each',evidence:'Screenshots or description of the chat UI'},
     {text:'Published in 2024',kind:'date',hardness:'hard',scope:'each',evidence:'model date guess'}]});
 assert.equal(c.source,'model');
 const kinds=hardEach(c).map(r=>r.kind);
 assert.deepEqual(kinds.sort(),['authority','date','subject']);
 const authority=c.requirements.find(r=>r.kind==='authority')!;
 assert.deepEqual(authority.authority,{entity:'WhatsApp',names:['WhatsApp'],domains:['blog.whatsapp.com','whatsapp.com']});
 const date=hardEach(c).find(r=>r.kind==='date')!;
 assert.deepEqual(date.date_range,{from:'2023-09-24',to:DAY},'the model\'s own date arithmetic is replaced');
 assert.ok(!c.requirements.some(r=>r.text==='Published in 2024'));
 assert.deepEqual(setRequirements(c)[0].set_items,['2023','2024','2025','2026']);
 assert.deepEqual(c.requirements.map(r=>r.id),c.requirements.map((_,i)=>`R${i+1}`),'stable sequential IDs');
});

test('an article-only request makes the format a hard requirement for every result',()=>{
 const c=rulesContract('rosswell ufo incident real article',DAY);
 const f=hardEach(c).find(r=>r.kind==='format')!;
 assert.deepEqual(f.formats,['article']);assert.equal(c.source,'rules');
 assert.deepEqual(c.deliverable,{formats:['article'],completeness:'any'});
});

test('a whole book asks for the complete work through legitimate access, and a format stays separate',()=>{
 const c=normaliseContract('robert greene art of seduction pdf',DAY,{completeness:'full',entities:[{name:'The Art of Seduction',kind:'work'}]});
 const full=c.requirements.find(r=>r.kind==='completeness')!;
 assert.deepEqual([full.hardness,full.scope,full.access],['hard','each','legitimate']);
 assert.ok(c.requirements.some(r=>r.kind==='format'&&r.formats?.includes('pdf')));
 assert.equal(rulesContract('the complete ebook of dune',DAY).deliverable.completeness,'full');
});

test('quoted phrases and exclusions are preserved; an unusable draft falls back to the rules',()=>{
 const c=normaliseContract('"chat themes" whatsapp -beta',DAY,{requirements:'not a list'});
 assert.equal(c.source,'rules');
 assert.ok(c.requirements.some(r=>r.kind==='subject'&&r.text.includes('chat themes')&&r.hardness==='hard'));
 assert.deepEqual(c.exclusions,['beta']);
 assert.equal(c.query,'"chat themes" whatsapp -beta','the original query is kept verbatim');
});

test('"websites" is a preference, not a hard format, so videos presenting sites are not rejected (the v4 recall lesson)',()=>{
 const c=rulesContract('websites with motion graphics and 3d elements',DAY);
 assert.deepEqual(c.requirements.map(r=>[r.kind,r.hardness]),[['format','preferred']]);
 assert.deepEqual(hardEach(c),[]);
 assert.equal(hardEach(rulesContract('3d website article',DAY)).find(r=>r.kind==='format')?.hardness,'hard','article still makes it hard');
});

test('without a planner draft, the word after "official" names the owner',()=>{
 const c=rulesContract('official whatsapp chat ui interface from over past 3 years',DAY);
 const a=c.requirements.find(r=>r.kind==='authority')!;
 assert.deepEqual(a.authority?.names,['whatsapp']);
 assert.equal(a.text,'From an official whatsapp source');
});

test('the planner schema lists every contract field as required, as strict structured output demands',()=>{
 for(const key of Object.keys(DRAFT_SCHEMA))assert.ok(DRAFT_REQUIRED.includes(key),key);
 const items=(DRAFT_SCHEMA.requirements as any).items;
 assert.deepEqual([...items.required].sort(),Object.keys(items.properties).sort());
});

test('model requirements that restate the date phrase or a set without items are dropped (seen from a live planner)',()=>{
 const c=normaliseContract('official whatsapp chat ui interface from over past 3 years',DAY,{
   requirements:[{text:'over past 3 years',kind:'property',hardness:'hard',scope:'set',evidence:'',set_items:[]},
     {text:'Covers each of the past 3 years',kind:'property',hardness:'hard',scope:'each',evidence:''},
     {text:'Shows the chat interface',kind:'subject',hardness:'hard',scope:'each',evidence:'UI shown',set_items:[]}]});
 assert.deepEqual(c.requirements.filter(r=>r.kind==='property'||r.kind==='subject').map(r=>r.text),['Shows the chat interface']);
});

test('authority requirements are never invented without the word official',()=>{
 const c=normaliseContract('whatsapp chat ui',DAY,{requirements:[{text:'From Meta',kind:'authority',hardness:'hard',scope:'each',evidence:''}],official_domains:['whatsapp.com']});
 assert.ok(!c.requirements.some(r=>r.kind==='authority'));
});
