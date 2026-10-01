import {test} from 'node:test';
import assert from 'node:assert/strict';
import {collapseDuplicates} from '../src/duplicates.js';

const r=(url:string,title:string)=>({url,title});
const kept=(list:{url:string;title:string}[])=>collapseDuplicates(list).kept.map(x=>x.url);

test('the same page, post or article shown twice keeps only its higher-ranked copy',()=>{
 const page=[r('https://www.bgremover.video/','Free Video Background Remover – No Watermark | BGRemover.vid'),
   r('https://www.bgremover.video/en','Free Video Background Remover – No Watermark | BGRemover.vid')];
 assert.deepEqual(kept(page),['https://www.bgremover.video/']);
 const reddit=[r('https://www.reddit.com/r/aigamedev/comments/1dwl68g/x','r/aigamedev on Reddit: I made a free background remover web app'),
   r('https://www.reddit.com/r/StableDiffusion/comments/1dwkwrx/x','r/StableDiffusion on Reddit: I made a free background remover web app')];
 assert.equal(kept(reddit).length,1);
 const medium=[r('https://medium.com/@muthonikinyanjui/whatsapp-redesign','WhatsApp Redesign Case Study (2020–2023) | by Muthoni Kinyanjui | Medium'),
   r('https://medium.com/@muthonidesigns/whatsapp-redesign-f','WhatsApp Redesign Case Study (2020–2023) - Medium')];
 assert.equal(kept(medium).length,1);
 const reupload=[r('https://www.youtube.com/watch?v=aaaaaaaaaaa','Cat Pushes Glass Off Table in Slow Motion - YouTube'),
   r('https://www.dailymotion.com/video/x1','Cat Pushes Glass Off Table in Slow Motion')];
 assert.equal(kept(reupload).length,1,'a re-upload on another video site under the identical title');
 const out=collapseDuplicates(page);
 assert.deepEqual(out.dropped,[{url:'https://www.bgremover.video/en',of:'https://www.bgremover.video/'}]);
});

test('different results on one topic, different outlets and short generic titles all stay',()=>{
 assert.equal(kept([r('https://www.dailymotion.com/video/x356v72','Crazy WTF Moments Compilation - 2015'),
   r('https://www.dailymotion.com/video/x3b75wi','Crazy WTF Moments Compilation - Funny Videos')]).length,2);
 assert.equal(kept([r('https://www.dailymail.co.uk/a','Is this proof of a Spanish YETI? | Daily Mail Online'),
   r('https://www.11alive.com/b','"Yeti" spotted at Spanish ski resort | 11alive.com')]).length,2);
 assert.equal(kept([r('https://www.youtube.com/watch?v=2I5BhmiTdIc','3 Free Ways to Get Any YouTube Video Transcript (No Software) - YouTube'),
   r('https://www.youtube.com/watch?v=FuqNluMTIR8','3 Simple Hacks to Get a YouTube Video Transcript - YouTube')]).length,2);
 assert.equal(kept([r('https://a.example/x','Free Solo - Wikipedia'),r('https://b.example/y','Free Solo - Wikipedia')]).length,2,'identical titles on unrelated sites are not copies');
 assert.equal(kept([r('https://site.example/a','Home'),r('https://site.example/b','Home')]).length,2,'too few words to tell');
});

test('a title part that merely mentions the site is part of the title, not decoration',()=>{
 assert.equal(kept([r('https://www.youtube.com/watch?v=2TDjbf1SWzA','How to Get Transcript of YouTube Video - Youtube Videos to Text - YouTube'),
   r('https://www.youtube.com/watch?v=TNy6czlVju8','How to Get a Transcript of a YouTube Video - YouTube')]).length,2);
 assert.equal(kept([r('https://www.youtube.com/watch?v=TNy6czlVju8','How to Get a Transcript of a YouTube Video - YouTube'),
   r('https://www.youtube.com/watch?v=0QzopZ78w9M','How To Get Transcript From YouTube Video? - YouTube')]).length,2,'three shared words are too few to call two videos copies');
 assert.equal(kept([r('https://www.bgremover.video/','Free Video Background Remover – No Watermark | BGRemover.video'),
   r('https://www.bgremover.video/en','Free Video Background Remover – No Watermark | BGRemover.video')]).length,1,'the site written as a domain is still decoration');
});
