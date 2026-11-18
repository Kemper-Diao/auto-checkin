import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { autoCheckInGLaDOS, renderTurnstile } from '../main.js';

// 在独立页面上下文和虚拟时钟中执行实际传给 page.evaluate 的函数。
const widget = (params = {}) => {
  let now = 0;
  let options;
  let nextId = 0;
  const timers = new Map();
  const promise = runInNewContext(`(${renderTurnstile.toString()})(params)`, {
    params: { sitekey: 'fixture', nonce: 'nonce', ...params },
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    document: { createElement: () => ({ style: {} }), body: { appendChild() {} } },
    window: { turnstile: { remove() {}, render(element, config) { options = config; } } }
  });
  return {
    promise,
    options,
    timers,
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    }
  };
};

test('silent verification may succeed after the old 15 second limit', async () => {
  const state = widget();
  state.advance(16_000);
  state.options.callback('fresh-token');
  assert.equal(await state.promise, 'fresh-token');
  assert.equal(state.timers.size, 0);
});

test('silent verification stops after 90 seconds with actionable diagnostics', async () => {
  const state = widget();
  const rejected = assert.rejects(state.promise, /timed out after 90000 ms.*--headed/);
  state.advance(90_000);
  await rejected;
  state.options.callback('too-late');
  assert.equal(state.timers.size, 0);
});

test('interaction does not extend the remaining challenge lifetime', async () => {
  const state = widget({ headless: false, timeoutMs: 4_000 });
  const rejected = assert.rejects(state.promise, /interaction timed out/);
  state.advance(3_000);
  state.options['before-interactive-callback']();
  state.advance(1_000);
  await rejected;
});

test('headless interaction fails promptly with manual verification instructions', async () => {
  const state = widget();
  state.options['before-interactive-callback']();
  await assert.rejects(state.promise, /requires manual interaction.*--headed/);
  assert.equal(state.timers.size, 0);
});

test('headed mode permits manual interaction and accepts the success callback', async () => {
  const state = widget({ headless: false });
  state.options['before-interactive-callback']();
  state.advance(20_000);
  state.options.callback('manual-token');
  assert.equal(await state.promise, 'manual-token');
});

for (const [callback, value, expected] of [
  ['error-callback', '110200', /Cloudflare code: 110200/],
  ['unsupported-callback', undefined, /does not support this browser/],
  ['callback', '', /empty token/],
  ['expired-callback', undefined, /token expired/]
]) {
  test(`reports ${callback} and clears the timer`, async () => {
    const state = widget();
    state.options[callback](value);
    await assert.rejects(state.promise, expected);
    assert.equal(state.timers.size, 0);
  });
}

test('checkin flow caps widget waiting by TTL and never submits after verification failure', async () => {
  let closed = false;
  let submitted = false;
  const page = {
    route: async () => {},
    goto: async () => {},
    waitForResponse: async () => ({
      ok: () => true,
      json: async () => ({ code: 0, nonce: 'nonce', ttl: 20_000, turnstile: 'fixture' })
    }),
    waitForFunction: async () => {},
    evaluate: async (fn, params) => {
      if (fn !== renderTurnstile) { submitted = true; return; }
      assert.ok(params.timeoutMs > 0 && params.timeoutMs <= 5_000);
      assert.equal(params.headless, false);
      throw new Error('Turnstile verification failed (Cloudflare code: 110200)');
    }
  };
  const browserType = {
    launch: async () => ({
      newContext: async () => ({ addCookies: async () => {}, newPage: async () => page }),
      close: async () => { closed = true; }
    })
  };
  await assert.rejects(autoCheckInGLaDOS({
    cookie: 'session=fixture', browserType, launchOptions: { headless: false }
  }), /Cloudflare code: 110200/);
  assert.equal(submitted, false);
  assert.equal(closed, true);
});

test('expiration during verification refreshes challenges at most twice without submitting', async t => {
  let now = 0;
  let attempts = 0;
  let evaluations = 0;
  t.mock.method(Date, 'now', () => now);
  const page = {
    route: async () => {},
    goto: async () => {},
    waitForResponse: async () => {
      attempts++;
      return {
        ok: () => true,
        json: async () => ({ code: 0, nonce: `nonce-${attempts}`, ttl: 18_000, turnstile: 'fixture' })
      };
    },
    waitForFunction: async () => {},
    evaluate: async (fn, params) => {
      assert.equal(fn, renderTurnstile, 'expired verification must never submit a request');
      assert.equal(params.timeoutMs, 3_000);
      assert.equal(params.headless, true);
      evaluations++;
      now += params.timeoutMs;
      throw new Error('Turnstile verification timed out after 3000 ms');
    }
  };
  const browserType = {
    launch: async () => ({
      newContext: async () => ({ addCookies: async () => {}, newPage: async () => page }),
      close: async () => {}
    })
  };
  await assert.rejects(autoCheckInGLaDOS({ cookie: 'session=fixture', browserType }), /expired before submission/);
  assert.equal(attempts, 2);
  assert.equal(evaluations, 2);
});
