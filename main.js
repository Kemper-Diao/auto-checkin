import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const HOST = 'https://glados.cloud';
const MIN_CHALLENGE_AGE = 2_500;
const EXPIRY_MARGIN = 15_000;
const API_HEADERS = {
  'sec-ch-ua-platform': '"Windows"',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'sec-ch-ua': '"Not-A.Brand";v="99", "Google Chrome";v="157", "Chromium";v="157"',
  'content-type': 'application/json;charset=UTF-8',
  'sec-ch-ua-mobile': '?0'
};

export const checkinProof = nonce => createHash('sha256')
  .update(`${nonce}.glados-observe-v1`, 'utf8')
  .digest('hex');

export const parseCookies = (cookie, host = HOST) => {
  if (typeof cookie !== 'string' || !cookie.trim()) throw new Error('GLADOS secret is missing');
  const cookies = cookie.split(';').filter(part => part.trim()).map(part => {
    const separator = part.indexOf('=');
    const name = part.slice(0, separator).trim();
    if (separator < 1 || !name || /[\s\x00-\x1f\x7f]/.test(name)) {
      throw new Error('GLADOS must contain a valid Cookie request header');
    }
    const value = part.slice(separator + 1).trim();
    if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('GLADOS contains an invalid Cookie value');
    return { name, value, url: `${host}/` };
  });
  if (!cookies.length) throw new Error('GLADOS secret is missing');
  return cookies;
};

// 在真实签到页面中运行，token 只由 Cloudflare 的成功回调提供。
export const renderTurnstile = ({ sitekey, nonce }) => new Promise((resolve, reject) => {
  let timer;
  let settled = false;
  const startedAt = Date.now();
  const finish = (error, token) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(new Error(error));
    else resolve(token);
  };
  const armTimeout = duration => {
    if (settled) return;
    clearTimeout(timer);
    timer = setTimeout(() => finish('Turnstile verification timed out'),
      Math.max(0, duration - (Date.now() - startedAt)));
  };

  // 替换页面自动创建的组件，确保本次回调明确对应当前 nonce。
  try { window.turnstile.remove(); } catch { /* 页面可能尚未创建组件。 */ }
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483647';
  document.body.appendChild(container);
  armTimeout(15_000);
  try {
    window.turnstile.render(container, {
      sitekey,
      action: 'checkin',
      cData: nonce,
      appearance: 'interaction-only',
      theme: 'auto',
      callback: token => {
        if (typeof token !== 'string' || !token.trim()) {
          finish('Turnstile returned an empty token');
        } else {
          finish(null, token);
        }
      },
      'before-interactive-callback': () => armTimeout(90_000),
      'error-callback': () => { finish('Turnstile verification failed'); return true; },
      'expired-callback': () => finish('Turnstile token expired'),
      'timeout-callback': () => finish('Turnstile interaction timed out')
    });
  } catch {
    finish('Unable to render Turnstile');
  }
});

const readJsonResponse = async response => {
  if (!response.ok()) throw new Error(`Challenge request failed: HTTP ${response.status()}`);
  try {
    return await response.json();
  } catch {
    throw new Error('Challenge response is not valid JSON');
  }
};

const getCheckinBody = async (page, host) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    // 使用网页自己发出的 challenge 请求，避免额外获取 nonce 使页面中的验证失效。
    const challengeResponse = page.waitForResponse(response =>
      response.url() === `${host}/api/user/checkin/challenge`
        && response.request().method() === 'GET', { timeout: 30_000 })
      .then(response => ({ response, at: Date.now() }));
    const [{ response, at }] = await Promise.all([
      challengeResponse,
      page.goto(`${host}/console/checkin`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    ]);
    const challenge = await readJsonResponse(response);
    if (!challenge || challenge.code == null || Number(challenge.code) !== 0
        || typeof challenge.nonce !== 'string' || !challenge.nonce.trim()) {
      throw new Error('Unable to obtain a checkin challenge; check the GLADOS login Cookie');
    }
    const ttl = Number(challenge.ttl || 300_000);
    if (!Number.isFinite(ttl) || ttl <= EXPIRY_MARGIN + MIN_CHALLENGE_AGE) {
      throw new Error('Challenge TTL is too short or invalid');
    }
    if (Date.now() - at >= ttl - EXPIRY_MARGIN) continue;

    let token;
    if (challenge.turnstile) {
      if (typeof challenge.turnstile !== 'string') throw new Error('Invalid Turnstile sitekey');
      console.log('Waiting for Turnstile verification...');
      await page.waitForFunction(() => typeof window.turnstile?.render === 'function',
        null, { timeout: 15_000 });
      token = await page.evaluate(renderTurnstile, {
        sitekey: challenge.turnstile,
        nonce: challenge.nonce
      });
    }

    await sleep(Math.max(0, MIN_CHALLENGE_AGE - (Date.now() - at)));
    // 验证期间也可能过期；只重新获取 challenge，不重试已经提交的签到请求。
    if (Date.now() - at >= ttl - EXPIRY_MARGIN) continue;
    return JSON.stringify({
      token: new URL(host).hostname,
      nonce: challenge.nonce,
      proof: checkinProof(challenge.nonce),
      tsState: token ? 'ok' : 'off',
      ...(token ? { turnstile: token } : {})
    });
  }
  throw new Error('Checkin challenge expired before submission');
};

// 请求在同一浏览器页面中发送，沿用验证期间更新的 Cookie、网络环境和会话。
const requestJson = async (page, url, method = 'GET', body) => page.evaluate(
  async ({ url, method, body }) => {
    const response = await fetch(url, {
      method,
      body,
      credentials: 'include',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`${method} ${new URL(url).pathname}: HTTP ${response.status}`);
    try {
      return await response.json();
    } catch {
      throw new Error(`${method} ${new URL(url).pathname}: response is not valid JSON`);
    }
  }, { url, method, body });

export const autoCheckInGLaDOS = async ({
  cookie = process.env.GLADOS,
  host = HOST,
  browserType = chromium,
  launchOptions = {}
} = {}) => {
  const cookies = parseCookies(cookie, host);
  const browser = await browserType.launch({ headless: true, ...launchOptions });
  try {
    const context = await browser.newContext({ userAgent: API_HEADERS['user-agent'] });
    await context.addCookies(cookies);
    const page = await context.newPage();
    // 只对 GLaDOS API 应用 curl 请求头，Cookie 由浏览器按域管理。
    await page.route(`${host}/api/**`, route => route.continue({
      headers: { ...route.request().headers(), ...API_HEADERS }
    }));
    const body = await getCheckinBody(page, host);
    const checkin = await requestJson(page, `${host}/api/user/checkin`, 'POST', body);
    if (!checkin || checkin.code == null || Number(checkin.code) !== 0) {
      throw new Error(`Checkin rejected: ${checkin?.message || checkin?.reason || 'unknown response'}`);
    }
    const status = await requestJson(page, `${host}/api/user/status`);
    const leftDays = status?.data?.leftDays;
    if (!status || status.code == null || Number(status.code) !== 0
        || leftDays == null || leftDays === '' || !Number.isFinite(Number(leftDays))) {
      throw new Error('Checkin accepted, but unable to read account status');
    }
    return ['Checkin OK', `${checkin.message || ''}`, `Left Days ${Number(leftDays)}`];
  } finally {
    await browser.close();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const channel = process.argv.find(argument => argument.startsWith('--channel='))?.slice(10);
  autoCheckInGLaDOS({ launchOptions: { headless: !process.argv.includes('--headed'), ...(channel ? { channel } : {}) } })
    .then(result => console.log(result.join('\n')))
    .catch(error => {
      process.exitCode = 1;
      console.error('Checkin Error:', error.message);
    });
}
