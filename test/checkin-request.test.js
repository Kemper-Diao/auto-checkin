import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { autoCheckInGLaDOS, checkinProof } from '../main.js';

// 模拟浏览器生命周期，执行实际请求函数，核实最终发送的 JSON。
for (const turnstile of ['fixture-sitekey', null, { unexpected: true }]) {
  test(`omits verification fields even when challenge.turnstile is ${JSON.stringify(turnstile)}`, async t => {
    let now = 0;
    let closed = false;
    const requests = [];
    t.mock.method(Date, 'now', () => now);
    const page = {
      route: async () => {},
      goto: async () => {},
      waitForResponse: async () => ({
        ok: () => true,
        json: async () => {
          now += 2_500;
          return { code: 0, nonce: 'fixture-nonce', ttl: 300_000, turnstile };
        }
      }),
      // 不提供 waitForFunction 或 Turnstile SDK，任何获取验证的调用都会导致测试失败。
      evaluate: async (fn, params) => runInNewContext(`(${fn.toString()})(params)`, {
        params,
        URL,
        AbortSignal,
        fetch: async (url, options) => {
          requests.push({ url, ...options });
          return {
            ok: true,
            json: async () => url.endsWith('/status')
              ? { code: 0, data: { leftDays: '5' } }
              : { code: 0, message: 'fixture result' }
          };
        }
      })
    };
    const browserType = {
      launch: async () => ({
        newContext: async () => ({ addCookies: async () => {}, newPage: async () => page }),
        close: async () => { closed = true; }
      })
    };
    assert.deepEqual(await autoCheckInGLaDOS({ cookie: 'session=fixture', browserType }),
      ['Checkin OK', 'fixture result', 'Left Days 5']);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://glados.cloud/api/user/checkin');
    assert.equal(requests[0].method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].body), {
      token: 'glados.cloud', nonce: 'fixture-nonce', proof: checkinProof('fixture-nonce')
    });
    assert.equal(closed, true);
  });
}

test('expired challenges are refreshed at most twice without submitting checkin', async t => {
  let now = 0;
  let attempts = 0;
  t.mock.method(Date, 'now', () => now);
  const page = {
    route: async () => {},
    goto: async () => {},
    waitForResponse: async () => ({
      ok: () => true,
      json: async () => {
        attempts++;
        now += 3_500;
        return { code: 0, nonce: `nonce-${attempts}`, ttl: 18_000 };
      }
    }),
    evaluate: async () => assert.fail('expired challenge must never be submitted')
  };
  const browserType = {
    launch: async () => ({
      newContext: async () => ({ addCookies: async () => {}, newPage: async () => page }),
      close: async () => {}
    })
  };
  await assert.rejects(autoCheckInGLaDOS({ cookie: 'session=fixture', browserType }), /expired before submission/);
  assert.equal(attempts, 2);
});
