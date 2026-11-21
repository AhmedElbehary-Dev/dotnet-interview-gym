import { BlockList, isIPv4 } from 'node:net';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';

const hosts = new Map([
  ['learn.microsoft.com', /^\/(?:[a-z]{2}-[a-z]{2}\/)?(?:dotnet|aspnet|ef|sql|azure|windows|visualstudio)(?:\/|$)/i],
  ['react.dev', /^\/(?:learn|reference)\//],
  ['www.postgresql.org', /^\/docs\//],
  ['developer.mozilla.org', /^\/[a-z-]+\/docs\//i],
  ['git-scm.com', /^\/docs\//],
  ['docs.github.com', /^\/[a-z]{2}\//],
  ['www.w3.org', /^\/TR\//]
]);
const blocked = new BlockList();
for (const [range, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]
]) blocked.addSubnet(range, bits, 'ipv4');
export const publicAddress = address => isIPv4(address) && !blocked.check(address, 'ipv4');

export function allowedDocumentationUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\/[a-z0-9.-]+\//i.test(value) || /[\\\s\u0000-\u001f\u007f?]/u.test(value)) return null;
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.port || !hosts.get(url.hostname)?.test(url.pathname) ||
      !/^\/[a-z0-9._~/-]*$/i.test(url.pathname)) return null;
  return url;
}

function readHtml(url, address, signal, requestImpl) {
  return new Promise((resolve, reject) => {
    const req = requestImpl(url, {
      agent: false, family: 4, signal, autoSelectFamily: false, rejectUnauthorized: true,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { Accept: 'text/html', 'Accept-Encoding': 'identity' }
    }, res => {
      const limit = 512 * 1024;
      const type = res.headers['content-type'] ?? '';
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.destroy();
        resolve({ location: res.headers.location });
        return;
      }
      if (res.statusCode !== 200 || !/^text\/html(?:;|$)/i.test(type) ||
          Number(res.headers['content-length']) > limit ||
          ![undefined, 'identity'].includes(res.headers['content-encoding'])) {
        res.destroy();
        resolve({ html: '' });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('error', reject);
      res.on('data', chunk => {
        size += chunk.length;
        if (size > limit) {
          res.destroy();
          resolve({ html: '' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

export async function readDocumentation(url, {
  resolver = new Resolver({ timeout: 1000, tries: 1 }), requestImpl = request
} = {}) {
  url = allowedDocumentationUrl(String(url));
  if (!url) return [];
  const signal = AbortSignal.timeout(3500);
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const addresses = await resolver.resolve4(url.hostname);
    signal.throwIfAborted();
    if (!addresses.length || !addresses.every(publicAddress)) return [];
    const origin = url.origin;
    let html = '';
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await readHtml(url, addresses[0], signal, requestImpl);
      if (response.html !== undefined) {
        html = response.html;
        break;
      }
      const next = typeof response.location === 'string' && URL.parse(response.location, url);
      if (!next || next.origin !== origin || !allowedDocumentationUrl(next.href)) return [];
      url = next;
    }
    const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html)?.[1] ?? html;
    const content = main.replace(/<!--[\s\S]*?-->|<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
    const fragments = [];
    for (const [, fragment] of content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)) {
      const text = fragment.replace(/<[^>]*>/g, '').replace(/&(lt|gt|amp|quot|apos|nbsp|#39);/g, (_, entity) =>
        ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ', '#39': "'" })[entity])
        .replace(/\s+/g, ' ').trim();
      if (text.length >= 30) fragments.push(text.slice(0, 450));
    }
    return fragments;
  } catch {
    return [];
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

const words = value => value.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];

export async function verifyDocumentation(candidate, reader = readDocumentation) {
  const terms = new Set(words([candidate.q, ...candidate.options].join(' ')));
  return Promise.all(candidate.sourceUrls.map(async (sourceUrl, source) => {
    const url = allowedDocumentationUrl(sourceUrl);
    const passages = url ? await reader(url).catch(() => []) : [];
    const ranked = passages.map(text => ({ text, score: new Set(words(text).filter(word => terms.has(word))).size }));
    ranked.sort((a, b) => b.score - a.score);
    return { source, passages: ranked.slice(0, 3).map(({ text }) => text.slice(0, 450)) };
  }));
}
