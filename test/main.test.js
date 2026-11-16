import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { autoCheckInGLaDOS, checkinProof, parseCookies } from '../main.js';

const SAMPLE_NONCE = 'ec3ebabbcab331a9f3b8e6f389a7bd3c';

test('proof matches the captured curl value', () => {
  assert.equal(checkinProof(SAMPLE_NONCE),
    'c5835447b9275c05dbbe71579fd4ba9f5f5505b7df4a0428138ac7c04fb82c67');
});

test('Cookie parsing preserves equals signs and rejects missing or malformed credentials', () => {
  assert.deepEqual(parseCookies('session=a=b==; other=two').map(({ name, value }) => ({ name, value })),
    [{ name: 'session', value: 'a=b==' }, { name: 'other', value: 'two' }]);
  for (const cookie of [undefined, '', ' ; ', 'invalid', '=missing-name', 'name=bad\r\nvalue']) {
    assert.throws(() => parseCookies(cookie));
  }
});

const withSite = async (mode, verify) => {
  const requests = [];
  const challenges = [];
  const widgets = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, method: req.method, headers: req.headers, body, at: Date.now() });
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/console/checkin') {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><body><script>
        fetch('/api/user/checkin/challenge').then(response => response.json()).then(challenge => {
          if (${JSON.stringify(mode)} === 'sdk-missing') return;
          window.turnstile = {
            remove() {},
            render(element, options) {
              fetch('/widget', { method: 'POST', body: JSON.stringify({
                sitekey: options.sitekey, action: options.action, nonce: options.cData
              }) });
              const mode = ${JSON.stringify(mode)};
              if (mode === 'verification-error') options['error-callback']();
              else if (mode === 'verification-timeout') options['timeout-callback']();
              else if (mode === 'empty-token') options.callback('');
              else {
                const wait = mode === 'expired-always' || (mode === 'expired-once' && challenge.attempt === 1) ? 3500 : 0;
                setTimeout(() => options.callback('token-for-' + options.cData), wait);
              }
              return 'fixture-widget';
            }
          };
        });
      </script></body></html>`);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/user/checkin/challenge') {
      const attempt = challenges.length + 1;
      const nonce = attempt === 1 ? SAMPLE_NONCE : 'fresh-nonce-after-expiry';
      challenges.push({ nonce, at: Date.now() });
      res.setHeader('Set-Cookie', 'session=refreshed; Path=/; HttpOnly; SameSite=Lax');
      if (mode === 'challenge-http-error') { res.writeHead(403); res.end('{}'); return; }
      res.end(JSON.stringify({
        code: mode === 'invalid-login' ? 1 : 0,
        nonce,
        ttl: mode === 'invalid-ttl' ? 100 : mode === 'expired-always' || (mode === 'expired-once' && attempt === 1) ? 18000 : 300000,
        turnstile: mode === 'off' ? null : 'fixture-sitekey',
        attempt
      }));
    } else if (req.url === '/widget') {
      widgets.push(JSON.parse(body));
      res.end('{}');
    } else if (req.url === '/api/user/checkin') {
      if (mode === 'checkin-http-error') { res.writeHead(503); res.end('{}'); return; }
      if (mode === 'checkin-invalid-json') { res.end('<html>not JSON</html>'); return; }
      res.end(JSON.stringify({ code: mode === 'checkin-rejected' ? 1 : 0, message: 'fixture result' }));
    } else if (req.url === '/api/user/status') {
      res.end(JSON.stringify({ code: 0, data: { leftDays: mode === 'invalid-status' ? null : '5' } }));
    } else {
      res.writeHead(404);
      res.end('{}');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  const run = () => autoCheckInGLaDOS({
    host,
    cookie: 'session=initial; other=a=b==',
    launchOptions: process.env.TEST_BROWSER_CHANNEL ? { channel: process.env.TEST_BROWSER_CHANNEL } : {}
  });
  try {
    await verify({ run, requests, challenges, widgets });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};

for (const mode of ['ok', 'off', 'expired-once']) {
  test(`browser flow: ${mode}`, { timeout: 30000 }, async () => withSite(mode, async ({ run, requests, challenges, widgets }) => {
    assert.deepEqual(await run(), ['Checkin OK', 'fixture result', 'Left Days 5']);
    const posts = requests.filter(request => request.path === '/api/user/checkin');
    assert.equal(posts.length, 1, 'checkin must be submitted exactly once');
    const post = posts[0];
    const payload = JSON.parse(post.body);
    const challenge = challenges.at(-1);
    assert.equal(payload.nonce, challenge.nonce);
    assert.equal(payload.proof, createHash('sha256').update(`${challenge.nonce}.glados-observe-v1`).digest('hex'));
    assert.equal(payload.token, '127.0.0.1');
    assert.ok(post.at - challenge.at >= 2500, 'submission must wait for minimum challenge age');
    assert.match(post.headers.cookie, /session=refreshed/);
    assert.match(post.headers.cookie, /other=a=b==/);
    assert.equal(post.headers['content-type'], 'application/json;charset=UTF-8');
    assert.equal(post.headers['sec-ch-ua-platform'], '"Windows"');
    assert.equal(post.headers.referer, undefined);
    if (mode === 'off') {
      assert.equal(payload.tsState, 'off');
      assert.equal(Object.hasOwn(payload, 'turnstile'), false);
      assert.equal(widgets.length, 0);
    } else {
      assert.equal(payload.tsState, 'ok');
      assert.equal(payload.turnstile, `token-for-${challenge.nonce}`);
      assert.deepEqual(widgets.at(-1), { sitekey: 'fixture-sitekey', action: 'checkin', nonce: challenge.nonce });
    }
    assert.equal(challenges.length, mode === 'expired-once' ? 2 : 1);
  }));
}

for (const [mode, message] of [
  ['verification-error', /verification failed/],
  ['verification-timeout', /interaction timed out/],
  ['empty-token', /empty token/],
  ['expired-always', /expired before submission/],
  ['invalid-login', /login Cookie/],
  ['invalid-ttl', /TTL/],
  ['challenge-http-error', /HTTP 403/],
  ['sdk-missing', /Timeout/]
]) {
  test(`does not submit when ${mode}`, { timeout: 35000 }, async () => withSite(mode, async ({ run, requests, challenges }) => {
    await assert.rejects(run, message);
    assert.equal(requests.filter(request => request.path === '/api/user/checkin').length, 0);
    assert.equal(challenges.length, mode === 'expired-always' ? 2 : 1);
  }));
}

for (const [mode, message] of [
  ['checkin-rejected', /Checkin rejected/],
  ['checkin-http-error', /HTTP 503/],
  ['checkin-invalid-json', /not valid JSON/],
  ['invalid-status', /unable to read account status/]
]) {
  test(`reports ${mode} without retrying checkin`, { timeout: 20000 }, async () => withSite(mode, async ({ run, requests }) => {
    await assert.rejects(run, message);
    assert.equal(requests.filter(request => request.path === '/api/user/checkin').length, 1);
    if (mode !== 'invalid-status') {
      assert.equal(requests.filter(request => request.path === '/api/user/status').length, 0);
    }
  }));
}
