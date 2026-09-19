import type { DB } from './db.js';
import type { Config } from './config.js';
import { fetchJSON, UpstreamError } from './http.js';
import { takeBudget } from './budgets.js';
import { providerHealth } from './health.js';

// Overload, rate limiting and timeouts are usually specific to one model, so the next configured model is tried. So is a
// model the provider no longer offers (404), which would otherwise switch AI off for every search despite working fallbacks.
const retryable = (error: unknown) => error instanceof UpstreamError &&
 (['rate_limited', 'timeout'].includes(error.code) || error.code === 'upstream_failure' && ((error.status ?? 0) >= 500 || error.status === 404));
// An overloaded model often stays overloaded for minutes and can take the whole timeout to fail, so it is tried last for a while.
// Most rate limits are per minute, so a rate-limited model is set aside for one minute; one whose daily quota is spent,
// or that no longer exists, is only tried again an hour later.
const cooldown = (error: unknown) => !(error instanceof UpstreamError) ? 5 * 60_000
 : error.status === 404 || error.code === 'rate_limited' && /PerDay/i.test(error.detail ?? '') ? 60 * 60_000
 : error.code === 'rate_limited' ? 60_000 : 5 * 60_000;
// Failures that say the model cannot be used right now (as opposed to an answer this app could not use), for the watchdog.
const unavailable = (error: unknown) => error instanceof UpstreamError && ['rate_limited', 'timeout', 'upstream_failure', 'network_error'].includes(error.code);
const failureCode = (error: UpstreamError) =>
 `${error.code === 'rate_limited' && /PerDay/i.test(error.detail ?? '') ? 'rate_limited_daily' : error.code}${error.status && error.code !== 'rate_limited' ? `_${error.status}` : ''}${error.detail ? ` ${error.detail}` : ''}`;
// Keyed by provider and model, so two providers offering the same model name never share a cooldown.
const coolingUntil = new Map<string,number>();
const perMinuteLimit = (error: unknown) => error instanceof UpstreamError && error.code === 'rate_limited' && !/PerDay/i.test(error.detail ?? '');
// The wait the API suggested, kept between 1 and 30 seconds; 10 seconds when it suggested none.
const retryDelayMs = (error: unknown) => {
 const seconds = Number(/retry=(\d+(?:\.\d+)?)s/.exec((error as UpstreamError).detail ?? '')?.[1] ?? 10);
 return Math.min(30_000, Math.max(1000, seconds*1000));
};
export interface InlineImage { label: string; mimeType: 'image/jpeg'; data: Buffer }

// The provider-independent half of a model client: which models to try in what order, when to set one aside, what to
// spend, and what to record. A subclass supplies only one provider's request and response shape.
export abstract class ModelClient {
 constructor(protected db: DB, protected config: Config, protected transport = fetchJSON) {}
 // Names this provider's health rows and cooldown keys, for example 'gemini'.
 protected abstract get provider(): string;
 abstract get models(): string[];
 protected abstract ask(model: string, system: string, text: string, schema: object, images: InlineImage[]): Promise<unknown>;
 private key(model: string) { return `${this.provider}:${model}`; }
 // Returns the parsed JSON reply and the model that produced it. Each attempt spends one unit of the named daily budget.
 // Each image follows the text, introduced by its label.
 async json(bucket: string, system: string, text: string, schema: object, images: InlineImage[] = []): Promise<{model: string; value: unknown}> {
   const now = Date.now();
   const cooling = (m: string) => (coolingUntil.get(this.key(m)) ?? 0) > now;
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
       coolingUntil.delete(this.key(model));
       await this.record(model, null);
       return {model, value};
     } catch (error) {
       failures.set(model, error);
       await this.record(model, error);
       if (retryable(error)) coolingUntil.set(this.key(model), Date.now() + cooldown(error));
       if (i === models.length - 1 || !retryable(error)) throw error;
     }
   }
   throw new UpstreamError('model_unavailable');
 }
 // Each model's run of failed calls, shown by the watchdog. A reply this app could not use still shows the model is up.
 private async record(model: string, error: unknown) {
   const down = unavailable(error);
   await providerHealth(this.db, this.key(model), !down, down ? failureCode(error as UpstreamError) : undefined).catch(() => {});
 }
}
