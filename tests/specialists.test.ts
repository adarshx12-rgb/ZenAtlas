import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InternetArchive, LibraryOfCongress, configuredArchives, specialistSearches} from '../src/specialists.js';
import {pageReferences} from '../src/pages.js';
import {searchInput} from '../src/types.js';
import {testConfig, database} from './helpers.js';
import {runDiscovery} from '../src/discovery.js';

test('native archive adapters validate entries, preserve unknown rights and use bounded native pagination',async()=>{
 const input=searchInput.parse({q:'moon "space flight"'});
 let asked='';
 const archive=new InternetArchive(testConfig,async(url)=>{asked=url;return {response:{numFound:80,docs:[
   {identifier:'flight_1',mediatype:'movies',title:'Space flight',description:['A film','about flight'],creator:['NASA'],date:'1969',licenseurl:'javascript:alert(1)'},
   {identifier:'../escape',mediatype:'movies',title:'Bad'},
   {identifier:'book',mediatype:'texts',title:'Wrong media'},
   {identifier:'flight_2',mediatype:'movies',title:'Moon flight',date:'1969-07-20',licenseurl:'https://creativecommons.org/publicdomain/mark/1.0/'},
 ]}};});
 const page=await archive.search(input.q,input,'2');
 assert.equal(new URL(asked).searchParams.get('page'),'2');
 assert.equal(new URL(asked).searchParams.get('q'),'mediatype:movies AND (collection:"prelinger" OR collection:"ephemera") AND (title:("moon" AND "space flight") OR description:("moon" AND "space flight") OR subject:("moon" AND "space flight"))');
 assert.equal(page.next_cursor,'3');
 assert.deepEqual(page.results.map(r=>r.url),['https://archive.org/details/flight_1','https://archive.org/details/flight_2']);
 assert.equal(page.results[0].description,'A film; about flight');
 assert.equal(page.results[0].published_at,null);assert.equal(page.results[0].license_url,null);
 assert.equal(page.results[1].rights_status,'unknown','reported license metadata is not independent rights verification');
 assert.equal(page.results[1].availability,'unknown');
 await assert.rejects(archive.search('q',input,'6'));
 const loc=new LibraryOfCongress(testConfig,async(url)=>{asked=url;return {results:[
   {id:'http://www.loc.gov/item/123/',title:'Historic footage',description:['Original recording'],contributor:['Library'],date:'1910-01-02'},
   {id:'https://www.loc.gov.evil.org/item/123/',title:'Wrong host'},
   {id:'https://www.loc.gov/collections/film/',title:'Collection'},
 ],pagination:{next:'https://evil.example/next'}};});
 const films=await loc.search('history',input);
 assert.equal(new URL(asked).searchParams.get('fa'),'online-format:video');
 assert.equal(films.next_cursor,'2','next links are never fetched directly');
 assert.deepEqual(films.results.map(r=>r.url),['https://www.loc.gov/item/123/']);
 assert.equal(films.results[0].rights_status,'unknown');
 await assert.rejects(new LibraryOfCongress(testConfig,async()=>({error:'blocked'})).search('q',input));
});

test('specialists follow the topic and explicit scope, independently of AI planning',()=>{
 assert.deepEqual(specialistSearches('security conference',2).map(s=>s.query),[
   'security conference site:media.ccc.de','security conference site:videolectures.net']);
 assert.ok(specialistSearches('historical footage',3).every(s=>s.target==='web'));
 assert.deepEqual(specialistSearches('site:example.org historical footage',3),[]);
 assert.deepEqual(specialistSearches('pasta recipes',3),[]);
 assert.deepEqual(configuredArchives(testConfig,'historic footage'),[]);
 assert.equal(configuredArchives({...testConfig,ARCHIVE_DISCOVERY:true},'historic footage').length,1);
 assert.equal(configuredArchives({...testConfig,ARCHIVE_DISCOVERY:true,LIBRARY_OF_CONGRESS_DISCOVERY:true},'historic footage').length,2);
 assert.deepEqual(configuredArchives({...testConfig,ARCHIVE_DISCOVERY:true},'3d websites'),[]);
 assert.deepEqual(configuredArchives({...testConfig,ARCHIVE_DISCOVERY:true},'site:example.org film'),[]);
});

test('page references retain real named works but exclude private addresses, scripts and navigation',()=>{
 const refs=pageReferences(`<a href="/film/orbit">Orbit by Ada</a><a href="/film/orbit">Duplicate</a>
   <a href="https://artist.example/work">Original artist</a><a href="http://127.0.0.1/private">Private</a>
   <a href="javascript:alert(1)">Run code</a><a href="/login">Login</a><a href="#more">More</a>`, 'https://festival.example/catalogue');
 assert.deepEqual(refs,[{url:'https://festival.example/film/orbit',title:'Orbit by Ada'},{url:'https://artist.example/work',title:'Original artist'}]);
});

test('an archive outage is partial, pagination survives, and zero budget makes no calls',async()=>{
 const db=await database();
 try{
   let calls=0;
   const good=new InternetArchive(testConfig,async()=>{calls++;return {response:{numFound:1,docs:[
     {identifier:'history',title:'Historical footage',mediatype:'movies'}]}};});
   const bad=new LibraryOfCongress(testConfig,async()=>{throw Error('offline');});
   const config={...testConfig,DEEP_PAGES:2};
   const out=await runDiscovery(db,config,searchInput.parse({q:'historical footage',depth:'deep'}),[],{archives:[good,bad]},async()=>{});
   assert.equal(out.results.length,1);assert.equal(calls,1);
   assert.deepEqual(out.providers.map(p=>[p.provider,p.status]),[['internet_archive','ok'],['library_of_congress','unavailable']]);
   const empty=await runDiscovery(db,{...config,ARCHIVE_DAILY_BUDGET:0},searchInput.parse({q:'other history',depth:'deep'}),[],{archives:[good]},async()=>{});
   assert.equal(empty.results.length,0);assert.equal(calls,1);assert.equal(empty.providers[0].status,'budget_exhausted');
 }finally{await db.close();}
});
