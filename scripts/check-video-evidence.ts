// Public, read-only adapter smoke check. No catalogue retention or credentials.
import {PublicVideoEvidence} from '../src/video-evidence.js';
const url=process.argv[2];
if(!url) throw new Error('Provide a public PeerTube watch URL or Internet Archive item URL');
const result=await new PublicVideoEvidence().check(url,{viewer_signals:true,transcripts:true});
console.log(JSON.stringify({provider:result.provider,comments:result.commentStatus,comment_count:result.comments.length,
 captions:result.captionStatus,caption_cues:result.caption?.segments.length??0}));
if(result.commentStatus==='unavailable'&&result.captionStatus==='unavailable') process.exitCode=1;
