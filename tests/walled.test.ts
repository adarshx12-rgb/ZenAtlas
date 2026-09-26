import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testConfig} from './helpers.js';
import {walledSite, walledToken, validWalledToken, walledPreview, clearWalledCache, loginPrompt} from '../src/walled.js';
import {UpstreamError} from '../src/http.js';

const db={async query(){return {rows:[{used:1}]};}} as any;
const config={...testConfig,REDDIT_CLIENT_ID:'',REDDIT_CLIENT_SECRET:''};
const noPages={check:async()=>{throw new Error('pages are not read');}};
const TWEET={url:'https://x.com/Interior/status/507185938620219395',author_name:'U.S. Department of the Interior',author_url:'https://x.com/Interior',
 html:'<blockquote class="twitter-tweet"><p lang="en" dir="ltr">Happy 50th anniversary to the Wilderness Act! Here&#39;s a photo from <a href="https://x.com/YosemiteNPS?ref_src=twsrc%5Etfw">@YosemiteNPS</a>. <a href="http://t.co/HMhbyTg18X">pic.twitter.com/HMhbyTg18X</a></p>&mdash; U.S. Department of the Interior (@Interior) <a href="https://x.com/Interior/status/507185938620219395?ref_src=twsrc%5Etfw">September 3, 2014</a></blockquote>\n'};

test('login-walled hosts are recognised, with subdomains; others are not',()=>{
 assert.deepEqual(walledSite('https://x.com/a/status/1'),{host:'x.com',site:'X'});
 assert.deepEqual(walledSite('https://mobile.twitter.com/a/status/1'),{host:'mobile.twitter.com',site:'X'});
 assert.equal(walledSite('https://www.reddit.com/r/movies/comments/abc/x/'),null,'Reddit posts open without signing in');
 assert.deepEqual(walledSite('https://www.quora.com/What-is-x'),{host:'quora.com',site:'Quora'});
 assert.equal(walledSite('https://example.org/x.com'),null);
 assert.equal(walledSite('https://notreddit.com/r/x'),null);
});

test('only URLs the engine signed can be previewed',()=>{
 const t=walledToken('secret-a','https://x.com/a/status/1');
 assert.ok(validWalledToken('secret-a','https://x.com/a/status/1',t));
 assert.ok(!validWalledToken('secret-a','https://x.com/a/status/2',t));
 assert.ok(!validWalledToken('secret-b','https://x.com/a/status/1',t));
 assert.ok(!validWalledToken('secret-a','https://x.com/a/status/1','short'));
});

test('X: the tweet comes from the public oEmbed endpoint as plain text, links and date',async()=>{
 clearWalledCache();
 const asked:string[]=[];
 const out=await walledPreview(db,config,'https://x.com/Interior/status/507185938620219395',{transport:(async(url:string)=>{asked.push(url);return TWEET;}) as any,pages:noPages});
 assert.match(asked[0],/^https:\/\/publish\.x\.com\/oembed\?url=https%3A%2F%2Fx\.com%2FInterior%2Fstatus%2F507185938620219395/);
 assert.equal(out.complete,true);assert.equal(out.source,'oembed');
 assert.equal(out.text,"Happy 50th anniversary to the Wilderness Act! Here's a photo from @YosemiteNPS. pic.twitter.com/HMhbyTg18X");
 assert.equal(out.author,'U.S. Department of the Interior');assert.equal(out.published,'September 3, 2014');
 assert.deepEqual(out.links.map(l=>l.text),['@YosemiteNPS','pic.twitter.com/HMhbyTg18X']);
 assert.ok(out.links.every(l=>/^https?:\/\//.test(l.url)));
});

test('Reddit without keys: oEmbed gives title and community, marked partial; with keys the API gives the post and comments',async()=>{
 clearWalledCache();
 const oembed={author_name:'someone',html:'<blockquote class="reddit-embed-bq"><a href="https://www.reddit.com/r/marvelstudios/comments/abc/doomsday_leak/">Doomsday set leak</a><br> by <a href="">u/someone</a> in <a href="https://www.reddit.com/r/marvelstudios/">marvelstudios</a></blockquote>'};
 const partial=await walledPreview(db,config,'https://www.reddit.com/r/marvelstudios/comments/abc/doomsday_leak/',{transport:(async()=>oembed) as any,pages:noPages});
 assert.deepEqual([partial.complete,partial.title,partial.author,partial.text],[false,'Doomsday set leak','someone',null]);
 clearWalledCache();
 const calls:{url:string;options:any}[]=[];
 const api=(async(url:string,options:any)=>{calls.push({url,options});
   if(url.includes('access_token'))return {access_token:'tok',expires_in:3600};
   return [{data:{children:[{data:{title:'Doomsday set leak',selftext:'Photos from the set in London.',author:'someone',created_utc:1758700000,permalink:'/r/marvelstudios/comments/abc/doomsday_leak/'}}]}},
     {data:{children:[{kind:'t1',data:{author:'fan1',body:'Looks real.'}},{kind:'more',data:{}},{kind:'t1',data:{author:'fan2',body:'Fake, the logo is wrong.'}}]}}];}) as any;
 const full=await walledPreview(db,{...config,REDDIT_CLIENT_ID:'id',REDDIT_CLIENT_SECRET:'sec'},'https://www.reddit.com/r/marvelstudios/comments/abc/doomsday_leak/',{transport:api,pages:noPages});
 assert.deepEqual([full.complete,full.title,full.text,full.author],[true,'Doomsday set leak','Photos from the set in London.','someone']);
 assert.deepEqual(full.comments,[{author:'fan1',text:'Looks real.'},{author:'fan2',text:'Fake, the logo is wrong.'}]);
 assert.equal(calls[0].options.body,'grant_type=client_credentials','the token request is a form body');
 assert.match(calls[0].options.headers.Authorization,/^Basic /);
 assert.match(calls[1].url,/^https:\/\/oauth\.reddit\.com\/comments\/abc\?/);
 assert.equal(calls[1].options.token,'tok');
});

test('other walled sites: readable page text is shown as partial; a login prompt or failure falls back to nothing',async()=>{
 clearWalledCache();
 const page=(text:string)=>({check:async()=>({status:'checked' as const,title:'What is the best Marvel film?',description:null,text,libraries:[],badges:[]})});
 const readable=await walledPreview(db,config,'https://www.quora.com/What-is-the-best-Marvel-film',{transport:(async()=>{throw new Error('no');}) as any,
   pages:page('Most fans pick Endgame for its scale. Others argue Winter Soldier is the better film because it grounds the story.')});
 assert.deepEqual([readable.complete,readable.source,readable.title],[false,'page','What is the best Marvel film?']);
 assert.match(readable.text!,/Winter Soldier/);
 clearWalledCache();
 const wall=await walledPreview(db,config,'https://www.quora.com/Another-question',{pages:page('Sign in to continue. Log in with Google or Facebook to see more answers.')});
 assert.deepEqual([wall.text,wall.source],[null,'snippet']);
 assert.ok(loginPrompt('Log in to Facebook to see this post'));
 assert.ok(!loginPrompt('The film follows Doctor Doom as he returns to sign in a new era of the multiverse, fighting the Avengers across worlds and timelines.'));
});

test('previews are cached; an exhausted budget returns the snippet fallback without calling anything',async()=>{
 clearWalledCache();
 let calls=0;
 const transport=(async()=>{calls++;return TWEET;}) as any;
 await walledPreview(db,config,'https://x.com/Interior/status/507185938620219395',{transport,pages:noPages});
 await walledPreview(db,config,'https://x.com/Interior/status/507185938620219395',{transport,pages:noPages});
 assert.equal(calls,1);
 clearWalledCache();
 const spent={async query(){return {rows:[]};}} as any;
 const out=await walledPreview(spent,config,'https://x.com/Interior/status/507185938620219395',{transport,pages:noPages});
 assert.deepEqual([out.source,out.text,calls],['snippet',null,1]);
 clearWalledCache();
 const failing=await walledPreview(db,config,'https://x.com/Interior/status/1',{transport:(async()=>{throw new UpstreamError('upstream_failure',404);}) as any,pages:noPages});
 assert.equal(failing.source,'snippet','a deleted tweet falls back to the snippet');
});
