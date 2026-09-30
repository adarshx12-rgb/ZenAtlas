import {test} from 'node:test';
import assert from 'node:assert/strict';
import {database,testConfig} from './helpers.js';
import {needsExpansion,creatorSearch,sameCreator,rewriterFrom} from '../src/link-expansion.js';
import {YouTubeData} from '../src/youtube.js';

test('expansion runs only when too few candidates look strong', () => {
 assert.equal(needsExpansion([0.6, 0.2], 2), true);
 assert.equal(needsExpansion([0.6, 0.5], 2), false);
 assert.equal(needsExpansion([], 2), true);
 assert.equal(needsExpansion([0.1], 0), false, 'a minimum of 0 turns expansion off');
});

test('the creator search is scoped to YouTube, quotes the name and keeps four terms', () => {
 assert.equal(creatorSearch('MrBeast', ['playstation', 'subscriber', 'console', 'fans', 'extra']), 'site:youtube.com "MrBeast" playstation subscriber console fans');
 assert.equal(creatorSearch('Mr "Beast"', []), 'site:youtube.com "Mr Beast"', 'quotes in a name cannot break the query');
});

test('a channel is the creator only when the folded names are equal', () => {
 assert.ok(sameCreator('MrBeast', 'Mr Beast'));
 assert.ok(!sameCreator('MrBeast Gaming', 'MrBeast'));
 assert.ok(!sameCreator('', ''));
});

test('the rewriter keeps new, non-empty searches up to the limit', async () => {
 const rewrite = rewriterFrom(async () => ({complete: false, missing: 'x', searches: ['mrbeast ps5 giveaway fan', 'mr beast buys ps5 to a subscriber', '', 'surprising a viewer with a ps5', 'third', 'fourth', 'fifth']}), 3);
 assert.deepEqual(await rewrite('q', [{id: 'R1', text: 't'}], ['mr beast buys ps5 to a subscriber']),
   ['mrbeast ps5 giveaway fan', 'surprising a viewer with a ps5', 'third']);
});

test('the upload scan resolves the handle, pages to the cap, spends one unit per call and finds nothing without a channel', async () => {
 const db = await database();
 try {
   const calls: URL[] = [];
   const page = (n: number, next?: string) => ({nextPageToken: next, items: Array.from({length: n}, (_, i) => ({snippet: {title: `Video ${i}`, description: 'd', resourceId: {videoId: `vid${String(i).padStart(8, '0')}`}}}))});
   const transport = async (url: string) => { const u = new URL(url); calls.push(u);
     if (u.pathname.endsWith('/channels')) return u.searchParams.get('forHandle') === '@MrBeast'
       ? {items: [{id: 'UC1', snippet: {title: 'MrBeast'}, contentDetails: {relatedPlaylists: {uploads: 'UU1'}}}]} : {items: []};
     return u.searchParams.get('pageToken') ? page(50, 'p3') : page(50, 'p2'); };
   const yt = new YouTubeData(db, {...testConfig, YOUTUBE_API_KEY: 'k', YOUTUBE_DAILY_UNITS: 100}, transport as any);
   const found = await yt.uploads('MrBeast', 70);
   assert.equal(found?.channel, 'MrBeast');
   assert.equal(found?.items.length, 70);
   assert.equal(calls.length, 3, 'one channel lookup and two pages');
   assert.equal((await db.query(`SELECT used FROM budgets WHERE bucket='youtube_units'`)).rows[0].used, 3);
   assert.equal(await yt.uploads('Nobody Here', 50), null);
 } finally { await db.close(); }
});

test('the rewriter is shown the titles found so far, at most ten', async () => {
 let sent: any;
 const rewrite = rewriterFrom(async text => { sent = JSON.parse(text as string); return {complete: false, missing: 'x', searches: ['a']}; }, 2);
 await rewrite('q', [], [], Array.from({length: 12}, (_, i) => `Title ${i} — Channel`));
 assert.equal(sent.titles_found.length, 10);
 assert.equal(sent.titles_found[0], 'Title 0 — Channel');
});
