import {z} from 'zod';
import {fetchJSON, fetchText} from './http.js';
import {contentHash} from './embeddings.js';
import type {ViewerComment} from './youtube.js';
import {tokens, STOPWORDS} from './ranking.js';

export type EvidenceState = 'available'|'empty'|'unavailable'|'not_permitted'|'unsupported';
export interface Caption {language:string;origin:string;version:string;segments:{start:number;end:number;text:string}[]}
export interface VideoEvidence {provider:string;comments:ViewerComment[];commentStatus:EvidenceState;captionStatus:EvidenceState;caption?:Caption;duration?:number}
export interface EvidencePolicy {viewer_signals:boolean;transcripts:boolean}
export interface VideoEvidenceAdapter {check(url:string, policy:EvidencePolicy, language?:string|null):Promise<VideoEvidence>}
const plain = (s:string) => s.replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').trim();
const stamp = (s:string) => {
 const m=/^(?:(\d{1,3}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(s);
 if(!m) throw new Error('Invalid caption timestamp');
 return Number(m[1]??0)*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/1000;
};
// SRT and WebVTT only: preserve publisher timing, reject malformed cues rather than invent alignment.
export function parseCaptions(text:string, duration?:number) {
 const segments:Caption['segments']=[];
 for(const block of text.replace(/^\uFEFF/,'').replace(/\r/g,'').split(/\n\s*\n/)) {
   const lines=block.trim().split('\n');
   if(/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
   const i=lines.findIndex(l=>l.includes('-->')); if(i<0) continue;
   const m=/^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[i]);
   if(!m) throw new Error('Invalid caption cue');
   const start=stamp(m[1]),end=stamp(m[2]),body=plain(lines.slice(i+1).join(' '));
   if(end<=start || (duration!==undefined && end>duration+0.5) || (segments.length && start<segments.at(-1)!.start)) throw new Error('Invalid caption timeline');
   if(body) segments.push({start,end,text:body.slice(0,4000)});
   if(segments.length>10000) throw new Error('Caption limit exceeded');
 }
 if(!segments.length) throw new Error('No caption cues');
 return segments;
}
// Reserve space for relevance, timestamps, corrections, recent comments and replies. Likes only break ties.
export function selectComments(comments:ViewerComment[],query:string,max=18):string[] {
 const terms=tokens(query).filter(t=>!STOPWORDS.has(t));
 const score=(c:ViewerComment)=>tokens(c.text).filter(t=>terms.includes(t)).length;
 const sorted=[...comments].sort((a,b)=>score(b)-score(a)||b.likes-a.likes||a.id.localeCompare(b.id));
 const groups=[sorted,sorted.filter(c=>/\d:\d{2}/.test(c.text)),sorted.filter(c=>/\b(not|wrong|incorrect|misleading|fake|actually|correction)\b/i.test(c.text)),sorted.filter(c=>c.sample==='recent'),sorted.filter(c=>c.sample==='reply')];
 const picked=new Map<string,string>();
 while(picked.size<max && groups.some(g=>g.length)) for(const group of groups) {
   const c=group.shift(); if(c && picked.size<max) picked.set(c.id,c.text.replace(/\s+/g,' ').slice(0,500));
 }
 return [...picked.values()];
}
const peerComment=z.object({id:z.number(),text:z.string(),isDeleted:z.boolean().optional(),heldForReview:z.boolean().optional()});
const peerList=z.object({data:z.array(peerComment).max(100)});
const archiveSchema=z.object({metadata:z.object({mediatype:z.string()}),
 files:z.array(z.object({name:z.string(),source:z.string().optional()})).max(20000),
 reviews:z.array(z.object({reviewbody:z.string().optional(),reviewtitle:z.string().optional(),reviewdate:z.string().optional()})).optional()});

export class PublicVideoEvidence implements VideoEvidenceAdapter {
 constructor(private json=fetchJSON, private text=fetchText) {}
 async check(input:string,policy:EvidencePolicy,language?:string|null):Promise<VideoEvidence> {
   const url=new URL(input);
   const peer=/^\/(?:w|videos\/watch)\/([\w-]{20,40})\/?$/.exec(url.pathname);
   const archive=url.hostname==='archive.org' && /^\/details\/([\w.-]+)\/?$/.exec(url.pathname);
   const out:VideoEvidence={provider:peer?'peertube':archive?'archive':'other',comments:[],
     commentStatus:policy.viewer_signals?'unsupported':'not_permitted',captionStatus:policy.transcripts?'unsupported':'not_permitted'};
   if((!peer && !archive)||(!policy.viewer_signals&&!policy.transcripts)) return out;
   const options={timeoutMs:6000,maxBytes:2*1024*1024,redirects:2};
   const caption=async(href:string,lang:string)=>{
     const target=new URL(href,url);
     // Provider-declared caption URLs still go through pinned public DNS and redirect checks.
     const response=await this.text(target.href,{...options,contentTypes:['text/vtt','text/plain','application/x-subrip','application/octet-stream'],accept:'text/vtt,text/plain,application/x-subrip'});
     const segments=parseCaptions(response.text,out.duration);
     out.caption={language:lang,origin:target.href,version:`caption:${contentHash(response.text).slice(0,32)}`,segments};
     out.captionStatus='available';
   };
   try {
     if(peer) {
       const base=`${url.origin}/api/v1/videos/${peer[1]}`;
       // Verify a real PeerTube video before using endpoints inferred from a watch URL.
       const video=z.object({uuid:z.string().uuid(),duration:z.number().positive(),commentsEnabled:z.boolean()}).parse(await this.json(base,options));
       if(peer[1].length===36 && video.uuid!==peer[1]) throw new Error('Video identity mismatch');
       out.duration=video.duration;
       if(policy.viewer_signals) {
         out.commentStatus=video.commentsEnabled?'unavailable':'empty';
         if(video.commentsEnabled) {
           const samples=await Promise.allSettled(['-totalReplies','-createdAt'].map(sort=>this.json(`${base}/comment-threads?count=50&sort=${sort}`,options).then(r=>peerList.parse(r))));
           for(const [i,s] of samples.entries()) if(s.status==='fulfilled') for(const c of s.value.data) if(!c.isDeleted&&!c.heldForReview) out.comments.push({id:String(c.id),text:plain(c.text),likes:0,sample:i?'recent':'relevant'});
           out.comments=[...new Map(out.comments.map(c=>[c.id,c])).values()];
           out.commentStatus=out.comments.length?'available':samples.some(s=>s.status==='fulfilled')?'empty':'unavailable';
         }
       }
       if(policy.transcripts) {
         out.captionStatus='unavailable';
         const data=z.object({data:z.array(z.object({language:z.object({id:z.string().min(2).max(20)}),captionPath:z.string()})).max(200)}).parse(await this.json(`${base}/captions`,options));
         const track=data.data.find(c=>c.language.id===language)??data.data.find(c=>c.language.id==='en')??data.data[0];
         if(track) await caption(track.captionPath,track.language.id); else out.captionStatus='empty';
       }
     } else if(archive) {
       const data=archiveSchema.parse(await this.json(`https://archive.org/metadata/${archive[1]}`,options));
       if(data.metadata.mediatype!=='movies') return out;
       if(policy.viewer_signals) {
         out.comments=(data.reviews??[]).slice(-100).map((r,i)=>({id:`review-${i}`,text:plain(`${r.reviewtitle??''} ${r.reviewbody??''}`),likes:0,sample:'recent'}));
         out.commentStatus=out.comments.length?'available':'empty';
       }
       if(policy.transcripts) {
         // Multi-film items have ambiguous timelines. Only associate a caption with one original video stem.
         const videos=new Set(data.files.filter(f=>f.source==='original'&&/\.(mp4|mkv|mov|ogv|webm|avi|mpeg|mpg)$/i.test(f.name)).map(f=>f.name.replace(/\.[^.]+$/,'')));
         const tracks=data.files.filter(f=>/\.(vtt|srt)$/i.test(f.name)&&[...videos].some(stem=>f.name.replace(/\.(vtt|srt)$/i,'')===stem));
         out.captionStatus='empty';
         if(videos.size===1&&tracks.length) {
           out.captionStatus='unavailable';
           await caption(`https://archive.org/download/${archive[1]}/${encodeURIComponent(tracks[0].name)}`,'und');
         }
       }
     }
   } catch { /* Preserve successful evidence from the other channel. */
     if(policy.viewer_signals&&out.commentStatus==='unsupported') out.commentStatus='unavailable';
     if(policy.transcripts&&out.captionStatus==='unsupported') out.captionStatus='unavailable';
   }
   return out;
 }
}
