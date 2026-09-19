import { z } from 'zod';
import { UpstreamError } from './http.js';
import { ModelClient, type InlineImage } from './model-client.js';

export const ORIGIN = 'https://generativelanguage.googleapis.com';
export type { InlineImage };
const response = z.object({
 candidates: z.array(z.object({
   finishReason: z.string().optional(),
   content: z.object({parts: z.array(z.object({text: z.string().optional(), thought: z.boolean().optional()})).default([])}).optional(),
 })).default([]),
 promptFeedback: z.object({blockReason: z.string().optional()}).optional(),
});

export class GeminiClient extends ModelClient {
 protected get provider() { return 'gemini'; }
 get models() {
   return [...new Set([this.config.JUDGE_MODEL || this.config.GEMINI_MODEL,
     ...this.config.JUDGE_FALLBACK_MODELS.split(',').map(m => m.trim()).filter(Boolean)])];
 }
 protected async ask(model: string, system: string, text: string, schema: object, images: InlineImage[]) {
   const url = new URL(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, ORIGIN);
   const parts = [{text}, ...images.flatMap(image => [{text: image.label},
     {inlineData: {mimeType: image.mimeType, data: image.data.toString('base64')}}])];
   const raw = response.parse(await this.transport(url.href, {method: 'POST', trustedOrigin: ORIGIN,
     headers: {'x-goog-api-key': this.config.GEMINI_API_KEY}, timeoutMs: this.config.JUDGE_TIMEOUT_MS, redirects: 0,
     body: {systemInstruction: {parts: [{text: system}]}, contents: [{role: 'user', parts}],
       generationConfig: {responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 8192,
         ...(images.length ? {mediaResolution: 'MEDIA_RESOLUTION_MEDIUM'} : {}),
         ...(this.config.JUDGE_THINKING_LEVEL === 'model_default' ? {} : {thinkingConfig: {thinkingLevel: this.config.JUDGE_THINKING_LEVEL}})}}}));
   if (raw.promptFeedback?.blockReason) throw new UpstreamError('model_blocked');
   const first = raw.candidates[0];
   if (!first || first.finishReason !== 'STOP') throw new UpstreamError('model_output_incomplete');
   try { return JSON.parse((first.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('')) as unknown; }
   catch { throw new UpstreamError('malformed_response'); }
 }
}
