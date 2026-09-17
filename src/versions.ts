// Version comparison for the watchdog: the part of npm's semver syntax that package.json, registry dist-tags and
// security advisories use (1.2.3, v24, 1.2.3-rc.1, comparators, ^ and ~, spaces for "and", || for "or", *).
export type Version = {major: number; minor: number; patch: number; pre: string[]};

export function parseVersion(text: string): Version|null {
 const m = /^\s*v?(\d+)(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(text);
 if (!m) return null;
 const part = (value: string|undefined) => value === undefined || value === 'x' || value === '*' ? 0 : Number(value);
 return {major: Number(m[1]), minor: part(m[2]), patch: part(m[3]), pre: m[4] ? m[4].split('.') : []};
}

// Negative when a is older. A prerelease sorts before its release; numeric identifiers compare as numbers.
export function compareVersions(a: Version, b: Version): number {
 const core = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
 if (core) return core;
 if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
 for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
   const x = a.pre[i], y = b.pre[i];
   if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
   if (x === y) continue;
   const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
   if (nx && ny) return Number(x) - Number(y);
   if (nx !== ny) return nx ? -1 : 1;
   return x < y ? -1 : 1;
 }
 return 0;
}

export function newer(a: string, b: string): boolean {
 const x = parseVersion(a), y = parseVersion(b);
 return !!x && !!y && compareVersions(x, y) > 0;
}

type Bound = {op: '<'|'<='|'>'|'>='|'='; version: Version};
const next = (v: Version, level: 'major'|'minor'|'patch'): Version =>
 level === 'major' ? {major: v.major+1, minor: 0, patch: 0, pre: ['0']}
 : level === 'minor' ? {major: v.major, minor: v.minor+1, patch: 0, pre: ['0']} : {major: v.major, minor: v.minor, patch: v.patch+1, pre: ['0']};

// One space-separated term as lower/upper bounds, or null when this matcher does not understand it.
function bounds(term: string): Bound[]|null {
 if (term === '*' || term === 'x' || term === 'latest') return [];
 const m = /^(\^|~|<=|>=|<|>|=)?(.+)$/.exec(term);
 if (!m) return null;
 const version = parseVersion(m[2]);
 if (!version) return null;
 // Parts left out ("1", "1.2", "1.x") leave that level open.
 const given = m[2].replace(/^v/, '').split(/[-+]/)[0].split('.').filter(p => p !== 'x' && p !== '*').length;
 const op = m[1] ?? '';
 if (op === '^') {
   const level = version.major > 0 || given === 1 ? 'major' : version.minor > 0 || given === 2 ? 'minor' : 'patch';
   return [{op: '>=', version}, {op: '<', version: next(version, level)}];
 }
 if (op === '~') return [{op: '>=', version}, {op: '<', version: next(version, given === 1 ? 'major' : 'minor')}];
 if ((op === '' || op === '=') && given < 3) return [{op: '>=', version}, {op: '<', version: next(version, given === 1 ? 'major' : 'minor')}];
 if (op === '<=' && given < 3) return [{op: '<', version: next(version, given === 1 ? 'major' : 'minor')}];
 if (op === '>' && given < 3) return [{op: '>=', version: next(version, given === 1 ? 'major' : 'minor')}];
 return [{op: (op || '=') as Bound['op'], version}];
}

// true or false when the range could be read; null when it uses syntax this matcher does not support.
export function satisfies(version: string, range: string): boolean|null {
 const v = parseVersion(version);
 if (!v) return null;
 let unknown = false;
 for (const alternative of range.split('||')) {
   const terms = alternative.trim().replace(/(<=|>=|<|>|=|\^|~)\s+/g, '$1').split(/\s+/).filter(Boolean);
   const all = terms.map(bounds);
   if (all.some(b => b === null)) { unknown = true; continue; }
   const ok = all.flat().every(b => {
     const c = compareVersions(v, b!.version);
     return b!.op === '<' ? c < 0 : b!.op === '<=' ? c <= 0 : b!.op === '>' ? c > 0 : b!.op === '>=' ? c >= 0 : c === 0;
   });
   if (ok) return true;
 }
 return unknown ? null : false;
}
