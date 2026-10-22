import { expect, it } from 'vitest';
import { classifyFailure, diagnosticFailure } from '../../src/shared/errors.js';
import { usageCost, usageFields } from '../../src/shared/usage.js';
it('执行边界归类结构化状态和 durable diagnostics，保留 rate_limit',()=>{
  expect(classifyFailure(Object.assign(new Error('opaque'),{status:401}),'web')).toEqual({kind:'auth',provider:'web',status:401});
  expect(diagnosticFailure({diagnostics:[{message:'HTTP 403 forbidden'}]},'web').kind).toBe('auth');
  expect(classifyFailure(new Error('HTTP 429'),'web').kind).toBe('rate_limit');
  expect(classifyFailure(new Error('ECONNRESET'),'web').kind).toBe('network');
});
