// Sound-tolerant transcript matching. Hindi auto-captions write English words in Devanagari ("anticipation gap" is
// "एंटीसिपेशन गैप"), and auto-captions mishear words, so exact keywords miss them. Both sides are reduced to sound keys:
// Devanagari is romanized, then each word becomes its consonant skeleton. Keys are used for matching only; quotes always
// show the stored caption text.

const CONSONANTS: Record<string, string> = {
 'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
 'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n', 'ऩ': 'n',
 'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ऱ': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'v',
 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
 'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y',
};
// With a nukta (़) the base letter changes sound: फ़ is f, ज़ is z.
const NUKTA: Record<string, string> = {'क': 'q', 'ख': 'kh', 'ग': 'g', 'ज': 'z', 'ड': 'r', 'ढ': 'rh', 'फ': 'f', 'य': 'y'};
const VOWELS: Record<string, string> = {'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai',
 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ऍ': 'e', 'ॲ': 'e'};
const SIGNS: Record<string, string> = {'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
 'ॉ': 'o', 'ॅ': 'e', 'ॆ': 'e', 'ॊ': 'o'};
const VIRAMA = '्', NUKTA_SIGN = '़', ANUSVARA = 'ं', CHANDRABINDU = 'ँ', VISARGA = 'ः';
const LABIALS = new Set(['प', 'फ', 'ब', 'भ', 'म']);

type Aksara = {consonant?: string; latin: string; vowel: string; inherent: boolean; nasal: string};

export const hasDevanagari = (text: string) => /[ऀ-ॿ]/.test(text);

// Latin spelling of Devanagari as a Hindi speaker would type it; any other text passes through unchanged.
export function romanize(text: string): string {
 // Letters and signs only: the danda (U+0964-5) and Devanagari digits (U+0966-F) are converted separately below.
 return text.normalize('NFC').replace(/[ऀ-ॣ॰-ॿ]+/g, word => romanizeWord([...word]))
   .replace(/[।॥]/g, '.').replace(/[०-९]/g, d => String(d.charCodeAt(0) - 0x966));
}

function romanizeWord(chars: string[]): string {
 const units: Aksara[] = [];
 for (let i = 0; i < chars.length; i++) {
   const c = chars[i], last = units.at(-1);
   if (CONSONANTS[c] !== undefined) {
     const nukta = chars[i + 1] === NUKTA_SIGN;
     units.push({consonant: c, latin: nukta ? NUKTA[c] ?? CONSONANTS[c] : CONSONANTS[c], vowel: 'a', inherent: true, nasal: ''});
     if (nukta) i++;
   } else if (VOWELS[c] !== undefined) units.push({latin: '', vowel: VOWELS[c], inherent: false, nasal: ''});
   else if (last && SIGNS[c] !== undefined) {
     // A second vowel sign (a typo in some captions) extends the vowel instead of adding a syllable.
     last.vowel = last.inherent ? SIGNS[c] : last.vowel + SIGNS[c]; last.inherent = false;
   } else if (last && c === VIRAMA) { last.vowel = ''; last.inherent = false; }
   else if (last && (c === ANUSVARA || c === CHANDRABINDU)) {
     // Before p/b/m an anusvara sounds as m ("नंबर" is number); elsewhere as n.
     last.nasal = c === ANUSVARA && LABIALS.has(chars[i + 1]) ? 'm' : 'n';
   } else if (last && c === VISARGA) last.nasal += 'h';
 }
 // Schwa deletion: the inherent a is silent at the end of a word (of more than one letter), and between a vowel and a
 // consonant that carries its own vowel ("वेबसाइट" is vebsait, not vebasait).
 const n = units.length;
 units.forEach((u, i) => {
   if (!u.consonant || !u.inherent || u.nasal) return;
   const next = units[i + 1], prev = units[i - 1];
   if (i === n - 1 && n > 1) u.vowel = '';
   else if (prev && (prev.vowel || prev.nasal) && next?.consonant && !next.inherent && next.vowel) u.vowel = '';
 });
 return units.map(u => u.latin + u.vowel + u.nasal).join('');
}

// The consonant skeleton of a Latin word: similar-sounding spellings share a key ("anticipation", "entisipeshan": ANTSPSN).
export function soundKey(word: string): string {
 let w = romanize(word).toLowerCase().replace(/[^a-z]/g, '');
 w = w.replace(/tch/g, 'ch').replace(/[ts]io(?=n)/g, 'sh').replace(/ch/g, 'C').replace(/sh/g, 's')
   .replace(/ph/g, 'f').replace(/([kgtdbjr])h/g, '$1').replace(/ck/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks')
   .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/C/g, 'c')
   .replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/w/g, 'v').replace(/z/g, 'j').replace(/h/g, '');
 const initial = /^[aeiouy]/.test(w) ? 'A' : '';
 return (initial + w.replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1')).toUpperCase();
}

const STOPWORDS = new Set(('a about above after again all also am an and any are as at be because been before being below between both but by can '
 + 'did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself '
 + 'just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their '
 + 'theirs them then there these they this those through to too under until up very was we were what when where which while who whom why '
 + 'will with you your yours video videos').split(' '));
const keysOf = (text: string) => (romanize(text).toLowerCase().match(/[a-z]+/g) ?? []).map(soundKey).filter(k => k.length >= 2);

// Keys of a caption line together with the next one, so a phrase split across two lines still matches.
export function soundKeys(text: string, next = ''): string[] {
 return [...new Set(keysOf(`${text} ${next}`))];
}

// Keys every matching line pair must contain. Queries with search operators keep their exact meaning, and a query whose
// keys are too short to be distinctive (a lone "gap") is not matched by sound at all.
export const MIN_QUERY_KEY_CHARS = 5;
export function queryKeys(q: string): string[] {
 if (/"|(^|\s)-\S|\bOR\b/.test(q)) return [];
 const words = (romanize(q).toLowerCase().match(/[a-z]+/g) ?? []).filter(w => !STOPWORDS.has(w));
 const keys = [...new Set(words.map(soundKey).filter(k => k.length >= 2))];
 return keys.join('').length >= MIN_QUERY_KEY_CHARS ? keys : [];
}
