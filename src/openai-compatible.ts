import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { fetchJSON, UpstreamError } from './http.js';
import { ModelClient, type InlineImage } from './model-client.js';

const response = z.object({choices: z.array(z.object({
 finish_reason: z.string().nullish(),
 message: z.object({content: z.string().nullish()}),
})).min(1)});
// Strict structured output rejects an object schema that does not forbid extra keys, at any depth. Only the planner's
// schemas reach this client today (the judge's uses minimum/maximum, which strict mode has historically rejected), but
// the requirement is added on the way out rather than in the caller so any future caller gets it for free.
const strict = (node: any): any => !node || typeof node !== 'object' ? node
 : {...node, ...(node.type === 'object' ? {additionalProperties: false} : {}),
   ...(node.properties ? {properties: Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, strict(v)]))} : {}),
   ...(node.items ? {items: strict(node.items)} : {})};

// Any endpoint speaking OpenAI's chat-completions API, such as OpenRouter. Models are given by whoever builds it:
// their ids carry slashes and colons, which the Gemini model settings do not allow.
export class OpenAICompatibleClient extends ModelClient {
 constructor(db: DB, config: Config, private modelList: string[], transport = fetchJSON) { super(db, config, transport); }
 protected get provider() { return 'openrouter'; }
 get models() { return this.modelList; }
 protected async ask(model: string, system: string, text: string, schema: object, images: InlineImage[]) {
   const url = new URL(`${this.config.OPENROUTER_BASE_URL.replace(/\/$/, '')}/chat/completions`);
   const parts = [{type: 'text', text}, ...images.flatMap(image => [{type: 'text', text: image.label},
     {type: 'image_url', image_url: {url: `data:${image.mimeType};base64,${image.data.toString('base64')}`}}])];
   const raw = response.safeParse(await this.transport(url.href, {method: 'POST', trustedOrigin: url.origin,
     token: this.config.OPENROUTER_API_KEY, timeoutMs: this.config.JUDGE_TIMEOUT_MS, redirects: 0,
     headers: {...(this.config.OPENROUTER_SITE_URL ? {'HTTP-Referer': this.config.OPENROUTER_SITE_URL} : {}),
       ...(this.config.OPENROUTER_SITE_NAME ? {'X-Title': this.config.OPENROUTER_SITE_NAME} : {})},
     body: {model, messages: [{role: 'system', content: system}, {role: 'user', content: images.length ? parts : text}],
       response_format: {type: 'json_schema', json_schema: {name: 'reply', schema: strict(schema), strict: true}},
       max_tokens: 8192}}));
   // A 200 carrying an error object, or anything else that is not a completion, is not an answer this app can use.
   if (!raw.success) throw new UpstreamError('malformed_response');
   const first = raw.data.choices[0];
   // Reasoning models can spend the whole token cap before writing any answer; that is a truncated reply, not bad JSON.
   if (first.finish_reason && first.finish_reason !== 'stop') throw new UpstreamError('model_output_incomplete');
   // Not every backend enforces the schema it was sent, so the reply is parsed and the caller validates its shape.
   try { return JSON.parse(first.message.content ?? '') as unknown; } catch { throw new UpstreamError('malformed_response'); }
 }
}
