import { BlockList, isIPv4 } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { createReadStream } from 'node:fs';
import { isMain } from './plan-question-generation.mjs';

const responseLimit = 512 * 1024;
const passageLimit = 450;
const unavailable = (failureCategory, httpStatus = null) => ({
  passages: [], diagnostic: { httpStatus, outcome: 'documentation_unavailable', passageCount: 0, failureCategory }
});
const extracted = (passages, httpStatus = null) => ({
  passages, diagnostic: {
    httpStatus, outcome: passages.length ? 'evidence_retrieved' : 'insufficient_evidence',
    passageCount: passages.length, failureCategory: passages.length ? null : 'no_passages'
  }
});

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
  return new Promise(resolve => {
    let httpStatus = null;
    const fail = category => resolve({ httpStatus, failureCategory: category });
    const transportFailure = () => fail(signal.aborted ? 'timeout' : 'network_error');
    const req = requestImpl(url, {
      agent: false, family: 4, signal, autoSelectFamily: false, rejectUnauthorized: true,
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
      headers: { Accept: 'text/html', 'Accept-Encoding': 'identity' }
    }, res => {
      httpStatus = res.statusCode;
      const type = res.headers['content-type'] ?? '';
      res.on('error', transportFailure);
      res.on('aborted', transportFailure);
      if ([301, 302, 303, 307, 308].includes(httpStatus)) {
        resolve({ httpStatus, location: res.headers.location });
        res.destroy();
        return;
      }
      const failureCategory = httpStatus !== 200 ? 'http_error' :
        Number(res.headers['content-length']) > responseLimit ? 'response_too_large' :
        !/^text\/html(?:;|$)/i.test(type) || ![undefined, 'identity'].includes(res.headers['content-encoding'])
          ? 'unsupported_response' : null;
      if (failureCategory) {
        fail(failureCategory);
        res.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > responseLimit) {
          fail('response_too_large');
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ httpStatus, html: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', transportFailure);
    req.end();
  });
}

async function lookupIPv4(hostname, lookupImpl) {
  // OS lookup cannot be cancelled. Discard results that arrive after the DNS budget.
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(resolve, 1000, null); });
  try {
    return await Promise.race([lookupImpl(hostname, { all: true, family: 4 }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectDocumentation(url, { lookupImpl = lookup, requestImpl = request } = {}) {
  url = allowedDocumentationUrl(String(url));
  if (!url) return unavailable('unsafe_url');
  const signal = AbortSignal.timeout(3500);
  let failureCategory = 'dns_error';
  let httpStatus = null;
  try {
    const addresses = await lookupIPv4(url.hostname, lookupImpl);
    signal.throwIfAborted();
    if (addresses === null) return unavailable('timeout');
    if (!addresses.length) return unavailable('dns_error');
    if (!addresses.every(({ address, family }) => family === 4 && publicAddress(address))) return unavailable('unsafe_address');
    const [{ address }] = addresses;
    const origin = url.origin;
    failureCategory = 'network_error';
    for (let redirects = 0; redirects <= 2; redirects++) {
      const response = await readHtml(url, address, signal, requestImpl);
      httpStatus = response.httpStatus;
      if (response.failureCategory) return unavailable(response.failureCategory, httpStatus);
      if (response.html !== undefined) return extracted(extractPassages(response.html), httpStatus);
      const next = typeof response.location === 'string' && URL.parse(response.location, url);
      if (!next || next.origin !== origin || !allowedDocumentationUrl(next.href)) {
        return unavailable('redirect_blocked', httpStatus);
      }
      url = next;
    }
    return unavailable('redirect_limit', httpStatus);
  } catch (error) {
    return unavailable(signal.aborted || error?.code === 'ETIMEOUT' ? 'timeout' : failureCategory, httpStatus);
  }
}

export async function readDocumentation(url, options) {
  return (await inspectDocumentation(url, options)).passages;
}

const entities = new Map(Object.entries({
  lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…'
}));
const blocks = new Set('address article blockquote caption dd details div dl dt figcaption figure h1 h2 h3 h4 h5 h6 hr li main ol p pre section summary table tbody td th thead tr ul'.split(' '));
const ignored = new Set('aside button footer form header nav svg'.split(' '));
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));

function extractPassages(html) {
  const visible = html.replace(/<!doctype\b[^>]*>|<!--[\s\S]*?(?:-->|$)|<(head|script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '');
  const main = /<main\b(?:"[^"]*"|'[^']*'|[^'"<>])*>([\s\S]*?)(?:<\/main\s*>|$)/i.exec(visible)?.[1];
  const article = /<article\b(?:"[^"]*"|'[^']*'|[^'"<>])*>([\s\S]*?)(?:<\/article\s*>|$)/i.exec(visible)?.[1];
  const passages = new Set();
  let hiddenTag;
  let hiddenDepth = 0;
  let fragment = '';
  const flush = () => {
    let remaining = fragment.replace(/&(#(?:x[0-9a-f]{1,6}|[0-9]{1,7})|[a-z]+);/gi, (original, entity) => {
      if (entity[0] !== '#') return entities.get(entity) ?? original;
      const hex = entity[1].toLowerCase() === 'x';
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff)
        ? String.fromCodePoint(point) : original;
    }).replace(/\s+/gu, ' ').trim();
    fragment = '';
    // Keep later claims in long blocks and retain context across a split.
    while (remaining.length >= 24) {
      const boundary = remaining.lastIndexOf(' ', passageLimit);
      const end = remaining.length <= passageLimit ? remaining.length : boundary >= 350 ? boundary : passageLimit;
      passages.add(remaining.slice(0, end));
      if (end === remaining.length) break;
      const overlap = remaining.indexOf(' ', end - 80);
      remaining = remaining.slice(overlap >= 0 && overlap < end ? overlap + 1 : end).trimStart();
    }
  };
  for (const [token, closing, name, attributes] of (main ?? article ?? visible)
    .matchAll(/<(\/)?([a-z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'"<>])*)>|[^<]+|</gi)) {
    const tag = name?.toLowerCase();
    const opens = tag && !closing && !voidTags.has(tag) && !attributes.endsWith('/');
    if (hiddenDepth) {
      if (tag === hiddenTag && closing) hiddenDepth--;
      if (tag === hiddenTag && opens) hiddenDepth++;
    } else if (opens &&
               (ignored.has(tag) || /\s(?:hidden(?=\s|=|$)|aria-hidden\s*=\s*(?:"true"|'true'|true(?=\s|$)))/i.test(attributes))) {
      flush();
      hiddenTag = tag;
      hiddenDepth = 1;
    } else if (blocks.has(tag)) {
      flush();
    } else if (tag === 'br') {
      fragment += ' ';
    } else if (!tag) {
      fragment += token;
    }
  }
  flush();
  return [...passages];
}

const words = value => value.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? [];

export async function verifyDocumentation(candidate, reader = inspectDocumentation) {
  const terms = new Set(words([candidate.q, ...candidate.options].join(' ')));
  return Promise.all(candidate.sourceUrls.map(async (sourceUrl, source) => {
    const url = allowedDocumentationUrl(sourceUrl);
    let result;
    try {
      result = url ? await reader(url) : unavailable('unsafe_url');
      if (Array.isArray(result)) result = extracted(result);
    } catch {
      result = unavailable('network_error');
    }
    const { passages, diagnostic } = result;
    const ranked = passages.map(text => ({ text, score: new Set(words(text).filter(word => terms.has(word))).size }));
    ranked.sort((a, b) => b.score - a.score);
    return { source, passages: ranked.slice(0, 3).map(({ text }) => text.slice(0, passageLimit)), diagnostic };
  }));
}

if (isMain(import.meta.url)) {
  const [flag, path, ...extra] = process.argv.slice(2);
  if (flag !== '--offline' || !path || extra.length) {
    console.error('Usage: node scripts/review-documentation.mjs --offline PATH_TO_HTML');
    process.exitCode = 1;
  } else {
    let result;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of createReadStream(path)) {
        size += chunk.length;
        if (size > responseLimit) break;
        chunks.push(chunk);
      }
      result = size > responseLimit ? unavailable('response_too_large') :
        extracted(extractPassages(Buffer.concat(chunks).toString('utf8')));
    } catch {
      result = unavailable('file_read_error');
    }
    console.log(JSON.stringify(result.diagnostic));
    if (!result.passages.length) process.exitCode = 1;
  }
}
