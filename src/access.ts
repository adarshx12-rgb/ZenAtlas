import { readFileSync } from 'node:fs';

// How a document can legitimately be read: see data/access-sources.json. The line is piracy, not copyright.
export type AccessKind = 'store'|'library'|'subscription'|'open_access'|'public_domain'|'publisher'|'unauthorized'|'unknown';
type Rule = {host: string; path?: string; kind: AccessKind};
const rules: Rule[] = JSON.parse(readFileSync(new URL('../data/access-sources.json', import.meta.url), 'utf8')).rules;
const ordered = [...rules.filter(r => r.kind === 'unauthorized'), ...rules.filter(r => r.kind !== 'unauthorized')];
const compiled = ordered.map(r => ({...r, pattern: r.path ? new RegExp(`^${r.path}`, 'i') : null}));

export function accessKind(url: string): AccessKind {
 try {
   const u = new URL(url), host = u.hostname.toLowerCase().replace(/^www\./, '');
   for (const rule of compiled) {
     if (host !== rule.host && !host.endsWith(`.${rule.host}`)) continue;
     if (rule.pattern && !rule.pattern.test(u.pathname)) continue;
     return rule.kind;
   }
 } catch { /* An unparseable address has no known access. */ }
 return 'unknown';
}
export const unauthorized = (url: string) => accessKind(url) === 'unauthorized';
export const fullCopyAccess = (kind: AccessKind) => !['unknown', 'unauthorized'].includes(kind);
const LABELS: Partial<Record<AccessKind,string>> = {store: 'Buy', library: 'Borrow', subscription: 'Subscription', open_access: 'Open access',
 public_domain: 'Public domain', publisher: 'Publisher'};
export const accessLabel = (kind: AccessKind) => LABELS[kind] ?? null;
