import {test} from 'node:test';
import assert from 'node:assert/strict';
import {linkedFrom} from '../src/corroboration.js';

const clip='https://www.youtube.com/watch?v=abcdefghijk',page='https://www.natgeo.com/free-solo';

test('other sites linking to, embedding or naming a video count once each; its own site never does',()=>{
 const out=linkedFrom([clip,page],[
   {url:'https://www.dexerto.com/story',links:[{url:'https://youtu.be/abcdefghijk'}]},
   {url:'https://news.example.org/a',text:'<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>'},
   {url:'https://news.example.org/b',links:[{url:clip}]},
   {url:'https://www.youtube.com/watch?v=zzzzzzzzzzz',links:[{url:clip}]},
   {url:'https://blog.example.net/x',links:[{url:'https://natgeo.com/free-solo/'}]},
   {url:'https://www.natgeo.com/other',links:[{url:page}]},
 ]);
 assert.deepEqual(out.get(clip),['dexerto.com','news.example.org']);
 assert.deepEqual(out.get(page),['blog.example.net']);
});

test('candidates nobody links to are left out, and bad addresses are ignored',()=>{
 const out=linkedFrom([clip],[{url:'not a url',links:[{url:clip}]},{url:'https://a.example/x',links:[{url:'https://www.youtube.com/watch?v=otherother1'}]}]);
 assert.equal(out.size,0);
});
