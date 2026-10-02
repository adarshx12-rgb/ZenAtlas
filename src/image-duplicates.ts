import sharp from 'sharp';
import type { ImageResult } from './images.js';
import { isCopy } from './image-sources.js';

// The same picture reaches the Images tab many times: resized, recompressed or re-hosted by Pinterest, stock sites and
// blogs, each with its own URL. A difference hash of the thumbnail (64 bits from a 9×8 greyscale) stays nearly the same
// through those changes, so images whose hashes differ in at most DUPLICATE_BITS bits are one picture. Of each such group
// the original publisher's copy is kept (not a stock or repin site), then the largest, then the first found.

const DUPLICATE_BITS = 6;

export async function differenceHash(data: Buffer): Promise<bigint|null> {
 try {
   const px = await sharp(data, {failOn: 'none', pages: 1}).grayscale().resize(9, 8, {fit: 'fill'}).raw().toBuffer();
   if (px.length !== 72) return null;
   let hash = 0n;
   for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | (px[y * 9 + x]! > px[y * 9 + x + 1]! ? 1n : 0n);
   return hash;
 } catch { return null; }
}
const bits = (n: bigint) => { let c = 0; for (; n; n &= n - 1n) c++; return c; };

// Keeps one image per picture, in the order the kept ones were found. `hashes` lines up with `images`; null is never a duplicate.
export function collapseDuplicates<T extends ImageResult>(images: T[], hashes: (bigint|null)[]): {kept: T[]; dropped: number} {
 const area = (image: T) => (image.width ?? 0) * (image.height ?? 0);
 const better = (a: number, b: number) => isCopy(images[a]!) !== isCopy(images[b]!) ? !isCopy(images[a]!) : area(images[a]!) > area(images[b]!);
 const groups: number[][] = [];
 images.forEach((_, i) => {
   const hash = hashes[i];
   const group = hash == null ? undefined : groups.find(g => hashes[g[0]!] != null && bits(hashes[g[0]!]! ^ hash) <= DUPLICATE_BITS);
   if (group) group.push(i); else groups.push([i]);
 });
 // A group sits where its first member was found, shown by its best member.
 const kept = groups.map(g => images[g.reduce((best, i) => better(i, best) ? i : best)]!);
 return {kept, dropped: images.length - kept.length};
}
