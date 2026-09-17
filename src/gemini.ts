import { z } from 'zod';
import type { DB } from './db.js';
import type { Config } from './config.js';
import { fetchJSON, UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';

const ORIGIN = 'https://generativelanguage.googleapis.com';
const response = z.object({
 candidates: z.array(z.object({
   finishReason: z.string().optional(),
   content: z.object({parts: z.array(z.object({text: z.string().optional(), thought: z.boolean().optional()})).default([])}).optional(),
 })).default([]),
 promptFeedback: z.object({blockReason: z.string().optional()}).optional(),
});

// Overload, rate limiting and timeouts are usually specific to one model, so the next configured model is tried.
const retryable = (error: unknown) => error instanceof UpstreamError &&
 (['rate_limited', 'timeout'].includes(error.code) || error.code === 'upstream_failure' && (error.status ?? 0) >= 500);
// An overloaded model often stays overloaded for minutes and can take the whole timeout to fail, so it is tried last for a while.
// Most rate limits are per minute, so a rate-limited model is set aside for one minute; one whose daily quota is spent
// is only tried again an hour later.
const cooldown = (error: unknown) => !(error instanceof UpstreamError) || error.code !== 'rate_limited' ? 5 * 60_000
 : /PerDay/i.test(error.detail ?? '') ? 60 * 60_000 : 60_000;
const coolingUntil = new Map<string,number>();
const perMinuteLimit = (error: unknown) => error instanceof UpstreamError && error.code === 'rate_limited' && !/PerDay/i.test(error.detail ?? '');
// The wait the API suggested, kept between 1 and 30 seconds; 10 seconds when it suggested none.
const retryDelayMs = (error: unknown) => {
 const seconds = Number(/retry=(\d+(?:\.\d+)?)s/.exec((error as UpstreamError).detail ?? '')?.[1] ?? 10);
 return Math.min(30_000, Math.max(1000, seconds*1000));
};
export interface InlineImage { label: string; mimeType: 'image/jpeg'; data: Buffer }

export class GeminiClient {
 constructor(private db: DB, private config: Config, private transport = fetchJSON) {}
 get models() {
   return [...new Set([this.config.JUDGE_MODEL || this.config.GEMINI_MODEL,
     ...this.config.JUDGE_FALLBACK_MODELS.split(',').map(m => m.trim()).filter(Boolean)])];
 }
 // Returns the parsed JSON reply and the model that produced it. Each attempt spends one unit of the named daily budget.
 // Each image follows the text, introduced by its label.
 async json(bucket: string, system: string, text: string, schema: object, images: InlineImage[] = []): Promise<{model: string; value: unknown}> {
   const now = Date.now();
   const cooling = (m: string) => (coolingUntil.get(m) ?? 0) > now;
   const failures = new Map<string,unknown>();
   try {
     return await this.attempt([...this.models.filter(m => !cooling(m)), ...this.models.filter(cooling)], failures, bucket, system, text, schema, images);
   } catch (error) {
     // A per-minute limit clears within the minute, so the models held back only by one are tried once more after a wait.
     const waiting = [...failures].filter(([, e]) => perMinuteLimit(e));
     if (!waiting.length) throw error;
     await new Promise(resolve => setTimeout(resolve, Math.min(...waiting.map(([, e]) => retryDelayMs(e)))));
     return this.attempt(waiting.map(([m]) => m), new Map(), bucket, system, text, schema, images);
   }
 }
 private async attempt(models: string[], failures: Map<string,unknown>, bucket: string, system: string, text: string, schema: object, images: InlineImage[]) {
   for (const [i, model] of models.entries()) {
     if (!await takeBudget(this.db, bucket, this.config.JUDGE_DAILY_BUDGET)) throw new UpstreamError('budget_exhausted');
     try {
       const value = await this.ask(model, system, text, schema, images);
       coolingUntil.delete(model);
       return {model, value};
     } catch (error) {
       failures.set(model, error);
       if (retryable(error)) coolingUntil.set(model, Date.now() + cooldown(error));
       if (i === models.length - 1 || !retryable(error)) throw error;
     }
   }
   throw new UpstreamError('model_unavailable');
 }
 private async ask(model: string, system: string, text: string, schema: object, images: InlineImage[]) {
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
