export interface Usage { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
const count = (n: unknown) => typeof n === 'number' && Number.isFinite(n) ? Math.max(0,n) : 0;
/** pi、衰老统一归一化；价格为每百万 token，缓存目前按输入同价估算。 */
export function usageFields(usage?: Usage) {
  return {input_tokens:count(usage?.input),output_tokens:count(usage?.output),
    cache_read_tokens:count(usage?.cacheRead),cache_write_tokens:count(usage?.cacheWrite)};
}
export function usageCost(usage: Usage, inputPrice = 0, outputPrice = 0) {
  const fields=usageFields(usage);
  const input=fields.input_tokens+fields.cache_read_tokens+fields.cache_write_tokens;
  return { input, output: fields.output_tokens, cost: (input*inputPrice+fields.output_tokens*outputPrice)/1e6 };
}
