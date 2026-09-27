import { createHash } from 'node:crypto';
import { z } from 'zod';
import { publicURL } from './urls.js';
import type { ImageResult } from './images.js';

// What an image's source says about it (docs/superpowers/specs/2026-09-27-candidate-quality-design.md). Whether an image
// is AI-generated is read from its source (an ai-image URL, a stock site's "Generative AI" label), never guessed from its
// pixels. Licences come from Openverse, which indexes openly licensed images (Wikimedia Commons, Flickr and others).

const AI_SOURCE = /(?:^|[^a-z])(?:ai[-_ ](?:generated|image|art|photo|illustration)|generated[-_ ]image|generative[-_ ]ai|midjourney|stable[-_ ]diffusion|dall[-_ ]?e)(?:[^a-z]|$)/i;
export const aiGenerated = (url: string, title: string) => AI_SOURCE.test(url) || AI_SOURCE.test(title);
export const excludesAI = (query: string) => /\b(?:not|no|non|without|never)[-\s]+ai\b|\bai[-\s]?free\b|\bhuman[-\s]made\b/i.test(query);
export const wantsLicense = (query: string) => /\b(?:licen[cs]e[sd]?|free to use|royalty[-\s]?free|creative commons|cc0|cc[-\s]by|public domain|attribution|copyright[-\s]?free)\b/i.test(query);

export interface ImageLicense { name: string; url: string|null; creator: string|null; attribution: string|null }
export function licenseLabel(license: string, version: string) {
 const l = license.toLowerCase();
 if (l === 'cc0') return 'CC0';
 if (l === 'pdm') return 'Public domain';
 return `CC ${l.toUpperCase()}${version ? ` ${version}` : ''}`;
}

const media = (value: unknown) => { if (typeof value !== 'string' || !value) return null; try { const u = publicURL(value).href; return u.length <= 2048 ? u : null; } catch { return null; } };
const row = z.looseObject({url: z.string(), foreign_landing_url: z.string(), license: z.string()});
// Openverse's search answer as image results with their licence; anything unusable is left out.
export function openverseResults(payload: unknown): (ImageResult & {license: ImageLicense})[] {
 const list = z.object({results: z.array(z.unknown()).max(100)}).safeParse(payload);
 if (!list.success) return [];
 return list.data.results.flatMap(raw => {
   const r = row.safeParse(raw);
   if (!r.success) return [];
   const image = media(r.data.url), page = media(r.data.foreign_landing_url);
   if (!image || !page) return [];
   const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
   return [{id: createHash('sha1').update(image).digest('hex'), title: text(r.data.title, 300) ?? new URL(page).hostname, image_url: image,
     thumbnail: media(r.data.thumbnail) ?? image, page_url: page, source_name: new URL(page).hostname.replace(/^www\./, ''),
     width: typeof r.data.width === 'number' ? r.data.width : null, height: typeof r.data.height === 'number' ? r.data.height : null, engine: 'openverse',
     license: {name: licenseLabel(r.data.license, typeof r.data.license_version === 'string' ? r.data.license_version : ''),
       url: media(r.data.license_url), creator: text(r.data.creator, 200), attribution: text(r.data.attribution, 500)}}];
 });
}
