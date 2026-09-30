import { STOPWORDS, sameWord, tokens } from './ranking.js';

// Names a search acts on must be grounded in what it really found. The link-expansion rewriter may say what the found
// titles show the request is about ("the guy who climbed El Capitan without ropes" is "Free Solo"); the name counts only
// when one found result carries every word of it, so a model cannot send the judge after a title it made up. The name is
// a lead for the judge, never proof that a candidate matches.

export interface IdentifyMaterial { title: string; description: string|null; creator: string|null }

const content = (text: string) => tokens(text).filter(t => !STOPWORDS.has(t));
// Every word of the name appears in one result's title, description or channel.
export function grounded(name: string, material: IdentifyMaterial[]): boolean {
 const words = content(name);
 if (!words.length) return false;
 return material.some(m => { const text = tokens(`${m.title} ${m.description ?? ''} ${m.creator ?? ''}`); return words.every(w => text.some(t => sameWord(w, t))); });
}
// A name is essentially one found title when it carries most (80%) of that title's words: the rewriter copying a video's
// title ("MrBeast Gave Away PS5 to Baba!") names that video, not what the request is about, and would let any uploader
// plant a "name" for the judge in their own title.
const titleOf = (name: string, material: IdentifyMaterial[]) => {
 const words = new Set(content(name));
 return material.some(m => { const t = content(m.title); return t.length > 0 && t.filter(w => words.has(w)).length / t.length >= 0.8; });
};
// A name the search may act on: short, carried by a found result, and not simply one found title.
export const acceptName = (name: string, material: IdentifyMaterial[]) => nameLike(name) && grounded(name, material) && !titleOf(name, material);
// A name is a few words (a show's full title can take eight: "That Time I Got Reincarnated as a Slime"); a whole result
// title with separators ("Free Solo - Alex Honnold Climbing … - YouTube") is not one.
export const nameLike = (name: string) => content(name).length <= 8 && !/[|]|\s[-–—]\s/.test(name);
