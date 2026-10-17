import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createUatEnvironmentScript } from './uat-environment';
describe('test tab environment isolation', () => {
  it('does not inject into production or accept markup as an environment', () => {
    expect(createUatEnvironmentScript(undefined)).toBe('');
    expect(createUatEnvironmentScript('</script>')).toBe('');
  });
  it('marks same-origin fetch while preserving body and never sends the marker to providers', async () => {
    const calls: Array<{ input: unknown; init: RequestInit | undefined }> = [];
    function Xhr() {}
    Xhr.prototype.open = () => {};
    Xhr.prototype.send = () => {};
    const context = createContext({ window: { fetch: async (input: unknown, init: RequestInit | undefined) => { calls.push({ input, init }); } }, location: { href:'https://shaozhuangai.com/models',origin:'https://shaozhuangai.com' }, URL, Headers, Request, XMLHttpRequest:Xhr });
    runInContext(createUatEnvironmentScript('creative-20261001'),context);
    await context.window.fetch('/api/model-gateway/orders',{method:'POST',body:'{}'});
    expect(new Headers(calls[0].init?.headers).get('X-Sanjie-Environment')).toBe('creative-20261001');
    expect(calls[0].init?.body).toBe('{}');
    await context.window.fetch('https://sub.shaozhuangai.com/v1/models',{headers:{Authorization:'Bearer test'}});
    expect(new Headers(calls[1].init?.headers).has('X-Sanjie-Environment')).toBe(false);
  });
});
