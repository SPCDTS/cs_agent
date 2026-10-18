import { expect, it } from 'vitest';
import { classifyFailure, diagnosticFailure } from '../../src/obs/errors.js';
import { usageCost, usageFields } from '../../src/obs/usage.js';
it('执行边界归类结构化状态和 durable diagnostics，保留 rate_limit',()=>{
  expect(classifyFailure(Object.assign(new Error('opaque'),{status:401}),'web')).toEqual({kind:'auth',provider:'web',status:401});
  expect(diagnosticFailure({diagnostics:[{message:'HTTP 403 forbidden'}]},'web').kind).toBe('auth');
  expect(classifyFailure(new Error('HTTP 429'),'web').kind).toBe('rate_limit');
  expect(classifyFailure(new Error('ECONNRESET'),'web').kind).toBe('network');
});
it('共享 usage 转换计入非零 cacheRead 和 cacheWrite',()=>{
  const usage={input:100,output:20,cacheRead:30,cacheWrite:10};
  expect(usageFields(usage)).toEqual({input_tokens:100,output_tokens:20,cache_read_tokens:30,cache_write_tokens:10});
  expect(usageCost(usage,2,4)).toEqual({input:140,output:20,cost:.00036});
});
