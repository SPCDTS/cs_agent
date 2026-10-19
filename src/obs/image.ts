import type { ImageBackend } from '../media/gen/image-gen.js';
import { trace, type Trace } from '../shared/trace.js';
/** 包装公共接口，生产与 fake 使用同一埋点；不改变提交、恢复、取消语义。 */
export function observeImages<T extends Pick<ImageBackend, 'name' | 'submit' | 'collect' | 'reconcile'>>(backend: T, ticket: string, observer: Trace = trace): T {
  return new Proxy(backend, { get(target, key) {
    if (key === 'submit') return (...args: Parameters<ImageBackend['submit']>) => observer.span(ticket, 'image:submit', () => target.submit(...args),
      { backend: target.name, prompt: args[0].prompt, filename_prefix: args[1]?.filenamePrefix }, prompt_id => ({ prompt_id }));
    if (key === 'collect') return (...args: Parameters<ImageBackend['collect']>) => observer.span(ticket, 'image:collect', () => target.collect(...args),
      { backend: target.name, prompt_id: args[0] }, images => ({ images }));
    if (key === 'reconcile') return (...args: Parameters<ImageBackend['reconcile']>) => observer.span(ticket, 'image:collect', () => target.reconcile(args[0], args[1], args[2], async step => {
      observer.event(ticket, 'recovered', { detail: { operation: 'image_reconcile', ...step } });
      await args[3]?.(step);
    }), { backend: target.name, operation: 'reconcile', filename_prefix: args[0].filenamePrefix }, result => result);
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
