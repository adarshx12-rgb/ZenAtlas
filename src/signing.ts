import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

// The thumbnail proxy fetches whatever address it is given, so it only accepts ones this server signed
// when it sent them to the client: an address that came out of a search, never one a caller made up.
export function signMedia(config: Config, url: string) {
 return createHmac('sha256',config.SESSION_SECRET).update(url).digest('base64url');
}
export function verifyMedia(config: Config, url: string, sig: string|undefined) {
 // timingSafeEqual throws on unequal lengths, so turn malformed signatures away first: a SHA-256 MAC is 43 base64url characters.
 if (!sig || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
 return timingSafeEqual(Buffer.from(sig),Buffer.from(signMedia(config,url)));
}
