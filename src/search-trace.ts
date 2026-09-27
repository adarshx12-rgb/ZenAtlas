import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';

const traces = new AsyncLocalStorage<string>();
export const traceFields = () => traces.getStore() ? {trace_id: traces.getStore()} : {};
export function withSearchTrace<T>(work: () => Promise<T>): Promise<T> {
 return traces.getStore() ? work() : traces.run(randomUUID(), work);
}

// Log reported usage only. A missing price is null, never a fabricated zero-dollar call.
export function decisionCost(config: Config, bucket: string, raw: unknown) {
 const r = raw as {model?: string; usage?: {cost?: number; prompt_tokens?: number; completion_tokens?: number}}|null;
 const u = r?.usage;
 process.stdout.write(`${JSON.stringify({event: 'model_cost', ...traceFields(), tier: config.TIER, bucket, model: r?.model ?? config.JEV_MODEL,
   input_tokens: typeof u?.prompt_tokens === 'number' ? u.prompt_tokens : null,
   output_tokens: typeof u?.completion_tokens === 'number' ? u.completion_tokens : null,
   cost: typeof u?.cost === 'number' ? u.cost : null})}\n`);
}
