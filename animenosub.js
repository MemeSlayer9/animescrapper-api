/**
 * Byse Stream Server v5 — Correct AES-256-GCM key strategy
 *
 * Key discovery (verified):
 *  payload1 + iv1  →  key = concat(key_parts[0], key_parts[1]) as base64url bytes  → sprintcdn URL ✅
 *  payload2 + iv2  →  key = concat(edge_1, edge_2) as base64url bytes              → bysevideo URL ✅
 *
 * Priority: always try sprintcdn (payload1) first, fall back to bysevideo (payload2)
 *
 * Routes:
 *   GET /                                  Web UI
 *   GET /extract?id=ID                     Auto-extract stream URL
 *   GET /extract?id=ID&referer=URL         With custom referer
 *   GET /playback?id=ID                    Raw API + decrypt preview
 *   GET /proxy?url=M3U8_URL               Reverse-proxy + rewrite m3u8
 *   GET /segment?url=SEG_URL              Proxy TS segments
 *   GET /stream/:slug                      Scrape animenosub.to slug → m3u8 page
 *   GET /scrape?url=EPISODE_URL           Raw scrape debug endpoint
 */

const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const crypto  = require('crypto');
const cheerio = require('cheerio');

const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// ── Constants ────────────────────────────────────────────────────────────────

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BYSE_HOST  = 'https://bysesayeveum.com';

// ── Helpers ──────────────────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  Accept:             'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':  'en-US,en;q=0.5',
  'Accept-Encoding':  'gzip, deflate, br',
  'Sec-CH-UA':        '"Brave";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
  'Sec-Fetch-Dest':   'iframe',
  'Sec-Fetch-Mode':   'navigate',
  'Sec-Fetch-Site':   'cross-site',
  'Sec-GPC':          '1',
  Connection:         'keep-alive',
};

function parseCookies(res) {
  return (res.headers['set-cookie'] || [])
    .map(c => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function httpGet(url, headers = {}, timeout = 15000) {
  return axios.get(url, {
    headers: {
      'User-Agent':      BROWSER_UA,
      'Accept':          'application/json, text/html, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers,
    },
    timeout,
    maxRedirects: 5,
    validateStatus: () => true,
  });
}

async function fetchRaw(url, extraHeaders = {}) {
  const resp = await axios.get(url, {
    headers:      { ...BROWSER_HEADERS, ...extraHeaders },
    timeout:      20000,
    maxRedirects: 10,
    decompress:   true,
  });
  return { data: resp.data, headers: resp.headers, status: resp.status };
}

async function postRaw(url, body, headers = {}) {
  const resp = await axios.post(url, body, {
    headers:      { ...BROWSER_HEADERS, ...headers },
    timeout:      20000,
    maxRedirects: 5,
    decompress:   true,
  });
  return resp.data;
}

// ── AES-256-GCM Decryption ───────────────────────────────────────────────────

/**
 * Decrypt an AES-256-GCM payload.
 * payloadB64 : base64url string  (ciphertext + 16-byte auth tag appended)
 * ivB64      : base64url string  (12 or 16 bytes; we try both)
 * keyBuf     : 32-byte Buffer
 * Returns parsed JSON object on success, or null.
 */
function tryDecrypt(payloadB64, ivB64, keyBuf) {
  for (const payEnc of ['base64url', 'base64']) {
    let payBuf;
    try { payBuf = Buffer.from(payloadB64, payEnc); } catch { continue; }
    if (payBuf.length < 17) continue;

    const authTag    = payBuf.slice(-16);
    const ciphertext = payBuf.slice(0, -16);

    for (const ivEnc of ['base64url', 'base64']) {
      let ivBuf;
      try { ivBuf = Buffer.from(ivB64, ivEnc); } catch { continue; }

      // Try full IV and truncated-to-12 IV
      const ivCandidates = [...new Set([ivBuf, ivBuf.slice(0, 12)])];

      for (const iv of ivCandidates) {
        try {
          const dec   = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv);
          dec.setAuthTag(authTag);
          const plain = Buffer.concat([dec.update(ciphertext), dec.final()]);
          return JSON.parse(plain.toString('utf8'));
        } catch { /* wrong key or IV */ }
      }
    }
  }
  return null;
}

/**
 * Derive the two confirmed working keys from a playback object and attempt
 * decryption.  Returns { decrypted, source } on success, or null.
 *
 * Strategy A (primary): key = key_parts[0] || key_parts[1]  →  payload / iv
 * Strategy B (fallback): key = edge_1 || edge_2             →  payload2 / iv2
 * Plus ~50 additional generic candidates for forward-compatibility.
 */
function decryptPlayback(pb, log = () => {}) {
  const { iv, payload, iv2, payload2, key_parts, decrypt_keys } = pb;

  // Normalise decrypt_keys into an array of values
  const dkValues = decrypt_keys
    ? (Array.isArray(decrypt_keys) ? decrypt_keys : Object.values(decrypt_keys)).filter(Boolean)
    : [];

  const kpValues = Array.isArray(key_parts) ? key_parts.filter(Boolean) : [];

  // ── Strategy A: key_parts concat → payload1  (sprintcdn) ─────────────────
  if (kpValues.length >= 2 && payload && iv) {
    try {
      const keyBuf = Buffer.concat(kpValues.map(k => Buffer.from(k, 'base64url')));
      const key32  = keyBuf.length >= 32 ? keyBuf.slice(0, 32)
                   : keyBuf.length  > 0  ? crypto.createHash('sha256').update(keyBuf).digest()
                   : null;
      if (key32) {
        const result = tryDecrypt(payload, iv, key32);
        if (result) {
          log(`[decrypt] ✅ Strategy A (key_parts concat) → payload1`);
          return { decrypted: result, source: 'strategy_a_sprintcdn' };
        }
      }
    } catch (e) { log(`[decrypt] Strategy A error: ${e.message}`); }
  }

  // ── Strategy B: edge_1 + edge_2 concat → payload2  (bysevideo) ───────────
  if (dkValues.length >= 2 && payload2 && iv2) {
    try {
      // Try every ordered pair from dkValues
      for (let i = 0; i < dkValues.length; i++) {
        for (let j = 0; j < dkValues.length; j++) {
          if (i === j) continue;
          const a = Buffer.from(dkValues[i], 'base64url');
          const b = Buffer.from(dkValues[j], 'base64url');
          const combined = Buffer.concat([a, b]);
          if (combined.length < 24) continue;
          const key32 = combined.length >= 32 ? combined.slice(0, 32)
                       : crypto.createHash('sha256').update(combined).digest();
          const result = tryDecrypt(payload2, iv2, key32);
          if (result) {
            log(`[decrypt] ✅ Strategy B (dk[${i}]+dk[${j}] concat) → payload2`);
            return { decrypted: result, source: 'strategy_b_bysevideo' };
          }
        }
      }
    } catch (e) { log(`[decrypt] Strategy B error: ${e.message}`); }
  }

  // ── Strategy C: generic exhaustive  ──────────────────────────────────────
  const seen = new Set();
  const candidates = [];

  const addKey = (buf, label) => {
    if (!Buffer.isBuffer(buf) || buf.length === 0) return;
    let k32 = buf.length >= 32 ? buf.slice(0, 32) : crypto.createHash('sha256').update(buf).digest();
    const hex = k32.toString('hex');
    if (seen.has(hex)) return;
    seen.add(hex);
    candidates.push({ k32, label });
  };

  const allVals = [...kpValues, ...dkValues];

  for (const v of allVals) {
    for (const enc of ['base64url', 'base64', 'hex', 'utf8']) {
      try { addKey(Buffer.from(v, enc), `${enc}(${v.slice(0,8)})`); } catch {}
    }
    addKey(crypto.createHash('sha256').update(v).digest(), `sha256(${v.slice(0,8)})`);
  }

  // All ordered pairs
  for (const a of allVals) {
    for (const b of allVals) {
      if (a === b) continue;
      for (const enc of ['base64url', 'base64', 'utf8']) {
        try {
          const combined = Buffer.concat([Buffer.from(a, enc), Buffer.from(b, enc)]);
          addKey(combined, `pair-${enc}`);
        } catch {}
      }
    }
  }

  // XOR of all base64url decoded
  try {
    const bufs = allVals.map(v => Buffer.from(v, 'base64url'));
    const len  = Math.max(...bufs.map(b => b.length));
    const xor  = Buffer.alloc(len, 0);
    for (const b of bufs) for (let i = 0; i < b.length; i++) xor[i] ^= b[i];
    addKey(xor, 'xor-all');
    addKey(crypto.createHash('sha256').update(xor).digest(), 'sha256(xor-all)');
  } catch {}

  // HMAC combinations
  for (const a of allVals) {
    const rest = allVals.filter(v => v !== a).join('');
    if (rest) addKey(crypto.createHmac('sha256', a).update(rest).digest(), `hmac-${a.slice(0,8)}`);
  }

  const payloadPairs = [];
  if (payload  && iv)  payloadPairs.push([payload,  iv,  'p1']);
  if (payload2 && iv2) payloadPairs.push([payload2, iv2, 'p2']);

  log(`[decrypt] Strategy C: trying ${candidates.length} keys × ${payloadPairs.length} payloads`);

  for (const { k32, label } of candidates) {
    for (const [pay, ivSrc, pLabel] of payloadPairs) {
      const result = tryDecrypt(pay, ivSrc, k32);
      if (result) {
        log(`[decrypt] ✅ Strategy C key=(${label}) → ${pLabel}`);
        return { decrypted: result, source: `strategy_c_${pLabel}` };
      }
    }
  }

  log(`[decrypt] ❌ All strategies exhausted`);
  return null;
}

// ── Pick best URL from decrypted sources ──────────────────────────────────────

function pickStreamUrl(decrypted, log = () => {}) {
  if (!decrypted) return null;

  const sources = decrypted.sources;
  if (Array.isArray(sources) && sources.length > 0) {
    // Prefer the sprintcdn URL
    const sprint = sources.find(s => s?.url && s.url.includes('sprintcdn'));
    if (sprint) { log(`[pick] sprintcdn: ${sprint.url}`); return sprint.url; }

    // Otherwise take first with a URL
    const first = sources.find(s => s?.url);
    if (first) { log(`[pick] first source: ${first.url}`); return first.url; }
  }

  // Deep scan for any m3u8 URL
  const text = JSON.stringify(decrypted);
  const m3u8 = (text.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/g) || [])[0];
  if (m3u8) { log(`[pick] deep scan m3u8: ${m3u8}`); return m3u8; }

  return null;
}

// ── Core extract function ─────────────────────────────────────────────────────

async function extractStream(videoId, pageReferer = 'https://animenosub.to/') {
  const log     = [];
  const info    = msg => { log.push(msg); console.log(msg); };
  const embedUrl = `${BYSE_HOST}/e/${videoId}`;

  info(`[extract] id=${videoId}`);

  // ── Step 1: fetch raw API metadata ───────────────────────────────────────
  const metaEndpoints = [
    `${BYSE_HOST}/api/videos/${videoId}`,
    `${BYSE_HOST}/api/video/${videoId}`,
    `${BYSE_HOST}/api/embed/${videoId}`,
  ];

  for (const endpoint of metaEndpoints) {
    let r;
    try {
      r = await httpGet(endpoint, {
        'Referer':        embedUrl,
        'Origin':         BYSE_HOST,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      });
    } catch (e) { info(`[meta] ${endpoint} error: ${e.message}`); continue; }

    info(`[meta] ${endpoint} → ${r.status}`);
    if (r.status !== 200 || !r.data) continue;

    const meta = typeof r.data === 'object' ? r.data : (() => { try { return JSON.parse(r.data); } catch { return {}; } })();
    const numericId = meta.id || meta.video_id || meta.numeric_id || null;

    info(`[meta] numericId=${numericId} | keys=${Object.keys(meta).join(', ')}`);

    // Check for unencrypted m3u8 in the response
    const bodyStr = JSON.stringify(meta);
    const inline  = (bodyStr.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/g) || []);
    if (inline.length) {
      info(`[meta] inline m3u8 found: ${inline[0]}`);
      return { success: true, url: inline[0], all: inline, numericId, meta, log };
    }

    // ── Step 2: decrypt playback ──────────────────────────────────────────
    const pb = meta.playback;
    if (!pb || typeof pb !== 'object') {
      info('[meta] no playback object, skipping decrypt');
      continue;
    }

    info(`[meta] playback keys: ${Object.keys(pb).join(', ')}`);
    info(`[meta] key_parts: ${JSON.stringify(pb.key_parts)}`);
    info(`[meta] decrypt_keys: ${JSON.stringify(pb.decrypt_keys)}`);

    const decResult = decryptPlayback(pb, info);
    if (!decResult) continue;

    const { decrypted } = decResult;
    info(`[decrypt] result keys: ${Object.keys(decrypted).join(', ')}`);

    const url = pickStreamUrl(decrypted, info);
    if (!url) {
      info('[decrypt] no stream URL found in decrypted payload');
      info('[decrypt] full payload: ' + JSON.stringify(decrypted).slice(0, 800));
      continue;
    }

    const all = Array.isArray(decrypted.sources)
      ? decrypted.sources.filter(s => s?.url).map(s => s.url)
      : [url];

    return {
      success:  true,
      url,
      all,
      numericId,
      meta,
      decrypted,
      log,
    };
  }

  return {
    success: false,
    url:     null,
    message: 'Decryption failed. Check log for details.',
    log,
  };
}

// ── m3u8 Proxy ───────────────────────────────────────────────────────────────

async function fetchM3u8(cdnUrl) {
  return axios.get(cdnUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept':     '*/*',
      'Referer':    'https://398fitus.com/',
      'Origin':     'https://398fitus.com',
    },
    timeout:        12000,
    responseType:   'text',
    validateStatus: () => true,
  });
}

function rewriteM3u8(text, originalUrl, proxyBase) {
  const base = new URL(originalUrl);
  return text.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    let abs;
    if      (t.startsWith('http')) abs = t;
    else if (t.startsWith('/'))    abs = `${base.protocol}//${base.host}${t}`;
    else {
      const dir = base.pathname.split('/').slice(0, -1).join('/');
      abs = `${base.protocol}//${base.host}${dir}/${t}`;
    }
    return `${proxyBase}/segment?url=${encodeURIComponent(abs)}`;
  }).join('\n');
}

// ── Utility: extract stream URLs from text ────────────────────────────────────

function extractStreamUrls(text) {
  const urls = [];
  const matches = text.match(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/g) || [];
  for (const u of matches) if (!urls.includes(u)) urls.push(u);
  return urls;
}

function findSnippets(text, keywords, contextBefore = 5, contextAfter = 250) {
  const snippets = [];
  for (const kw of keywords) {
    let idx = 0;
    while ((idx = text.indexOf(kw, idx)) !== -1) {
      const start = Math.max(0, idx - contextBefore);
      const end   = Math.min(text.length, idx + contextAfter);
      snippets.push(text.slice(start, end));
      idx += kw.length;
      if (snippets.length > 30) break;
    }
  }
  return snippets;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// ── /scrape debug endpoint ────────────────────────────────────────────────────

app.get('/scrape', async (req, res) => {
  const episodeUrl = req.query.url || 'https://animenosub.to/rent-a-girlfriend-season-5-episode-2/';
  const log = [];

  try {
    log.push(`[1] Fetching: ${episodeUrl}`);
    const { data: html } = await fetchRaw(episodeUrl, { Referer: 'https://animenosub.to/' });
    const $ = cheerio.load(html);

    const iframes = [];
    $('iframe, [data-src]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && src.startsWith('http')) iframes.push(src);
    });
    log.push(`[1] Iframes: ${JSON.stringify(iframes)}`);

    const iframeResults = [];

    for (const iframeSrc of iframes) {
      log.push(`\n[2] ══ Iframe: ${iframeSrc}`);
      const iframeOrigin = new URL(iframeSrc).origin;
      const iframeHost   = new URL(iframeSrc).host;
      const videoId      = iframeSrc.split('/e/')[1]?.split('?')[0];
      log.push(`[2] Video ID: ${videoId}`);

      const result = {
        url:             iframeSrc,
        videoId,
        streamUrls:      [],
        externalScripts: [],
        bundleScans:     [],
        apiProbe:        [],
        error:           null,
      };

      try {
        const { data: iframeHtml } = await fetchRaw(iframeSrc, {
          Referer:          episodeUrl,
          'Sec-Fetch-Dest': 'iframe',
          Origin:           new URL(episodeUrl).origin,
        });

        const $i = cheerio.load(iframeHtml);

        // Inline scripts
        $i('script:not([src])').each((_, el) => {
          extractStreamUrls($i(el).html() || '').forEach(u => {
            if (!result.streamUrls.includes(u)) result.streamUrls.push(u);
          });
        });

        // External scripts
        $i('script[src]').each((_, el) => {
          const src = $i(el).attr('src');
          if (!src) return;
          const full = src.startsWith('http')
            ? src
            : `${iframeOrigin}${src.startsWith('/') ? '' : '/'}${src}`;
          result.externalScripts.push(full);
        });
        log.push(`[2b] External scripts: ${result.externalScripts.length}`);

        // Scan app bundles (skip polyfills / 3rd party)
        for (const scriptUrl of result.externalScripts) {
          if (!scriptUrl.includes(iframeHost)) {
            log.push(`     Skip (3rd party): ${scriptUrl}`);
            continue;
          }
          log.push(`     Scanning bundle: ${scriptUrl}`);
          const scan = { url: scriptUrl, byteLength: 0, streamUrls: [], apiSnippets: [], error: null };

          try {
            const { data: jsText } = await fetchRaw(scriptUrl, {
              Referer:          iframeSrc,
              'Sec-Fetch-Dest': 'script',
              'Sec-Fetch-Mode': 'no-cors',
            });

            scan.byteLength   = jsText.length;
            scan.streamUrls   = extractStreamUrls(jsText);
            scan.apiSnippets  = findSnippets(jsText, [
              '/api/', 'fetch(', '.post(', '.get(', 'XMLHttpRequest',
              'source', 'stream', 'token', 'm3u8', 'hls',
              'owphbf', 'sprintcdn', 'edge',
            ], 5, 250);

            log.push(`     Size: ${jsText.length} bytes | streams: ${scan.streamUrls.length} | snippets: ${scan.apiSnippets.length}`);
            scan.streamUrls.forEach(u => {
              if (!result.streamUrls.includes(u)) result.streamUrls.push(u);
            });
          } catch (err) {
            scan.error = err.message;
            log.push(`     ERROR: ${err.message}`);
          }
          result.bundleScans.push(scan);
        }

        // Probe API if nothing found yet
        if (result.streamUrls.length === 0 && videoId) {
          log.push(`[3] Probing API endpoints for ${videoId} on ${iframeHost}…`);
          const jsonH = {
            Referer:             iframeSrc,
            Origin:              iframeOrigin,
            Accept:              'application/json, text/plain, */*',
            'X-Requested-With':  'XMLHttpRequest',
            'Sec-Fetch-Dest':    'empty',
            'Sec-Fetch-Mode':    'cors',
            'Sec-Fetch-Site':    'same-origin',
          };

          const paths = [
            `/api/source/${videoId}`,
            `/api/v1/source/${videoId}`,
            `/api/v2/source/${videoId}`,
            `/api/video/${videoId}`,
            `/api/stream/${videoId}`,
            `/api/embed/${videoId}`,
            `/api/file/${videoId}`,
            `/api/get/${videoId}`,
            `/source/${videoId}`,
            `/stream/${videoId}`,
            `/api/sources?id=${videoId}`,
          ];

          for (const path of paths) {
            const url = `${iframeOrigin}${path}`;
            for (const method of ['GET', 'POST']) {
              try {
                let data;
                if (method === 'GET') {
                  const r = await fetchRaw(url, jsonH);
                  data = r.data;
                } else {
                  data = await postRaw(
                    url,
                    `r=${encodeURIComponent(iframeSrc)}&d=${encodeURIComponent(iframeHost)}&id=${videoId}`,
                    { ...jsonH, 'Content-Type': 'application/x-www-form-urlencoded' }
                  );
                }
                const text    = typeof data === 'string' ? data : JSON.stringify(data);
                const streams = extractStreamUrls(text);
                const hit     = streams.length > 0 || text.includes('m3u8') || text.includes('.mp4');

                log.push(`  ${hit ? '✅' : '✗'} ${method} ${url} (${text.length}b)`);
                if (hit) {
                  result.apiProbe.push({ method, url, streams, preview: text.slice(0, 1000) });
                  streams.forEach(u => {
                    if (!result.streamUrls.includes(u)) result.streamUrls.push(u);
                  });
                }
              } catch (err) {
                log.push(`  ERR ${method} ${url}: ${err.response?.status || ''} ${err.message}`);
              }
            }
          }
        }

        log.push(`[2] Final stream URLs: ${JSON.stringify(result.streamUrls)}`);
      } catch (err) {
        result.error = err.message;
        log.push(`[2] ERROR: ${err.message}`);
      }

      iframeResults.push(result);
    }

    const allStreamUrls = [...new Set(iframeResults.flatMap(r => r.streamUrls))];
    res.json({ success: true, url: episodeUrl, allStreamUrls, iframeResults, log });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, log });
  }
});

// ── /playback — Raw API dump + decrypt preview ────────────────────────────────

app.get('/playback', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Provide ?id=VIDEO_ID' });
  try {
    const embedUrl = `${BYSE_HOST}/e/${id}`;
    const r = await httpGet(`${BYSE_HOST}/api/videos/${id}`, {
      'Referer':        embedUrl,
      'Origin':         BYSE_HOST,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
    });

    const pb    = r.data?.playback ?? null;
    const dkNorm = pb?.decrypt_keys
      ? (Array.isArray(pb.decrypt_keys) ? pb.decrypt_keys : Object.values(pb.decrypt_keys)).filter(Boolean)
      : null;

    let decryptResult = null;
    if (pb) {
      const dr = decryptPlayback(pb);
      if (dr) decryptResult = dr.decrypted;
    }

    res.json({
      status:                  r.status,
      data:                    r.data,
      playback:                pb,
      key_parts:               pb?.key_parts    ?? null,
      decrypt_keys:            pb?.decrypt_keys ?? null,
      decrypt_keys_normalised: dkNorm,
      decrypted:               decryptResult,
      stream_url:              decryptResult ? pickStreamUrl(decryptResult) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /extract — Main extract endpoint ─────────────────────────────────────────

app.get('/extract', async (req, res) => {
  const { id, url, referer } = req.query;

  // Allow direct CDN URL passthrough
  if (url) {
    if (!url.includes('.m3u8')) return res.json({ success: false, message: 'URL does not look like m3u8' });
    return res.json({ success: true, url, all: [url], log: ['Direct URL provided'] });
  }

  if (!id) return res.status(400).json({ error: 'Provide ?id=VIDEO_ID or ?url=CDN_URL' });

  try {
    res.json(await extractStream(id, referer || 'https://animenosub.to/'));
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── /proxy — m3u8 reverse proxy (rewrites segment URLs through /segment) ──────

app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');
  try {
    const r = await fetchM3u8(url);
    if (r.status !== 200) return res.status(r.status).send(`CDN returned ${r.status}. Token may be expired.`);
    const rewritten = rewriteM3u8(r.data, url, `${req.protocol}://${req.get('host')}`);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
  } catch (e) {
    res.status(500).send(`Proxy error: ${e.message}`);
  }
});

// ── /segment — TS segment proxy ───────────────────────────────────────────────

app.get('/segment', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');
  try {
    const r = await axios.get(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer':    'https://398fitus.com/',
        'Origin':     'https://398fitus.com',
        'Accept':     '*/*',
      },
      responseType:   'arraybuffer',
      timeout:        20000,
      validateStatus: () => true,
    });
    const ct = r.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    const buf = Buffer.from(r.data);
    if (ct.includes('mpegurl') || url.includes('.m3u8')) {
      res.send(rewriteM3u8(buf.toString('utf8'), url, `${req.protocol}://${req.get('host')}`));
    } else {
      res.send(buf);
    }
  } catch (e) {
    res.status(500).send(`Segment error: ${e.message}`);
  }
});

// ── /stream/:slug — Scrape animenosub.to slug → stream page or JSON ──────────
// GET /stream/rent-a-girlfriend-season-5-episode-2        → HTML page
// GET /stream/rent-a-girlfriend-season-5-episode-2?json   → JSON response
// GET /stream/rent-a-girlfriend-season-5-episode-2        with Accept: application/json → JSON

app.get('/stream/:slug', async (req, res) => {
  const { slug } = req.params;
  const episodeUrl = `https://animenosub.to/${slug}/`;
  const log = [];

  // Detect JSON mode: ?json param OR Accept: application/json header
  const wantsJson = ('json' in req.query)
    || (req.headers['accept'] || '').includes('application/json');

  const sendError = (status, msg, extraFields = {}) => {
    if (wantsJson) {
      return res.status(status).json({ success: false, slug, error: msg, log, ...extraFields });
    }
    return res.status(status).send(renderStreamPage(slug, extraFields.videoId || null, null, log, msg));
  };

  try {
    // Step 1: fetch the episode page
    log.push(`[stream] Fetching: ${episodeUrl}`);
    const { data: html } = await fetchRaw(episodeUrl, { Referer: 'https://animenosub.to/' });
    const $ = cheerio.load(html);

    // Step 2: find the Byse iframe
    let videoId = null;
    $('iframe, [data-src]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (src.includes('bysesayeveum.com')) {
        const match = src.match(/\/e\/([^/?#]+)/);
        if (match) { videoId = match[1]; return false; }
      }
    });

    if (!videoId) {
      log.push('[stream] No Byse iframe found on page');
      return sendError(404, 'No Byse embed found on this episode page.');
    }

    log.push(`[stream] Video ID: ${videoId}`);

    // Step 3: extract stream URL
    const result = await extractStream(videoId, episodeUrl);
    log.push(...result.log);

    if (!result.success || !result.url) {
      return sendError(502, result.message || 'Decryption failed.', { videoId });
    }

    // Step 4: respond
    if (wantsJson) {
      return res.json({
        success:   true,
        slug,
        videoId,
        url:       result.url,
        all:       result.all,
        proxy_url: `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(result.url)}`,
        title:     result.meta?.title        || null,
        duration:  result.meta?.duration_seconds || null,
        views:     result.meta?.views        || null,
        poster:    result.meta?.poster_url   || result.decrypted?.poster_url || null,
        expires_at: result.decrypted?.expires_at || null,
        sources:   result.decrypted?.sources || [],
        numericId: result.numericId,
        log,
      });
    }

    return res.send(renderStreamPage(slug, videoId, result, log));

  } catch (err) {
    log.push(`[stream] ERROR: ${err.message}`);
    return sendError(500, err.message);
  }
});

// ── HTML renderer for /stream/:slug ──────────────────────────────────────────

function renderStreamPage(slug, videoId, result, log, errMsg = null) {
  const title  = result?.meta?.title
    || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const m3u8   = result?.url  || null;
  const all    = result?.all  || [];
  const poster = result?.meta?.poster_url || result?.decrypted?.poster_url || null;
  const dur    = result?.meta?.duration_seconds
    ? `${Math.floor(result.meta.duration_seconds / 60)}m ${result.meta.duration_seconds % 60}s`
    : null;

  const esc = s => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const sourceButtons = all.map(u => {
    const label = u.includes('sprintcdn') ? '🚀 sprintcdn'
                : u.includes('bysevideo') ? '📦 bysevideo'
                : '🔗 CDN';
    return `<button class="cdn-btn" onclick="setStream(${JSON.stringify(esc(u))})">${label}</button>`;
  }).join('');

  const logHtml = log.map(l => {
    const cls = l.includes('✅') ? 'ok'
              : (l.includes('❌') || l.includes('ERROR') || l.includes('error')) ? 'er'
              : l.includes('[decrypt]') || l.includes('[key]') ? 'kk'
              : l.includes('[pick]') || l.includes('sprint') ? 'sk'
              : 'lo';
    return `<span class="${cls}">${esc(l)}</span>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0f0f13;color:#e0e0e0;min-height:100vh;padding:24px;max-width:980px;margin:0 auto}
h1{color:#fff;font-size:1.35rem;margin-bottom:6px;line-height:1.3}
.breadcrumb{color:#666;font-size:.8rem;margin-bottom:20px}
.breadcrumb a{color:#9a9aff;text-decoration:none}.breadcrumb a:hover{text-decoration:underline}
.card{background:#1a1a24;border:1px solid #2a2a3a;border-radius:12px;padding:20px;margin-bottom:16px}
h2{font-size:.95rem;color:#bbb;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.badge{display:inline-block;padding:2px 9px;border-radius:4px;font-size:.7rem;font-weight:700}
.bok{background:#1a3a1a;color:#7fdb7f;border:1px solid #2a5a2a}
.benc{background:#1a1a3a;color:#7fa7ff;border:1px solid #2a2a6a}
.berr{background:#3a1a1a;color:#f87;border:1px solid #6a2a2a}
.meta-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;font-size:.8rem;color:#666}
.meta-row span{color:#999}
.m3u8-box{background:#0a0a10;border:1px solid #2a5a2a;border-radius:8px;padding:14px 16px;font-family:monospace;font-size:.76rem;color:#7fdb7f;word-break:break-all;margin-bottom:12px;line-height:1.5;cursor:pointer;transition:border .2s}
.m3u8-box:hover{border-color:#5aaa5a}
.err-box{color:#f87;background:#1a0a0a;border:1px solid #422;border-radius:8px;padding:14px;font-size:.85rem;margin-bottom:14px}
.cdns{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.cdn-btn{font-size:.75rem;padding:5px 12px;border-radius:4px;border:1px solid #333;color:#aaa;background:#0f0f13;cursor:pointer;transition:all .2s}
.cdn-btn:hover,.cdn-btn.active{border-color:#6c63ff;color:#9a9aff;background:#1a1a2a}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:0}
button{background:#6c63ff;color:#fff;border:none;border-radius:8px;padding:9px 18px;font-size:.88rem;cursor:pointer;font-weight:600;transition:background .2s}
button:hover{background:#5a52dd}
.btn-outline{background:transparent;border:1px solid #6c63ff;color:#9a9aff}
.btn-outline:hover{background:#6c63ff22}
.btn-copy{background:transparent;border:1px solid #444;color:#888;font-size:.78rem;padding:6px 12px}
.btn-copy:hover{border-color:#7fdb7f;color:#7fdb7f;background:transparent}
video{width:100%;border-radius:8px;margin-top:14px;background:#000;max-height:520px;display:block}
#log{font-family:monospace;font-size:.74rem;background:#0a0a10;border:1px solid #222;border-radius:8px;padding:12px;max-height:280px;overflow-y:auto;white-space:pre-wrap;line-height:1.55}
.lo{color:#666}.ok{color:#7fdb7f}.er{color:#f87}.kk{color:#ffd97d}.sk{color:#ff9aff}
.toast{position:fixed;bottom:24px;right:24px;background:#1a3a1a;border:1px solid #2a5a2a;color:#7fdb7f;padding:10px 18px;border-radius:8px;font-size:.82rem;opacity:0;transition:opacity .3s;pointer-events:none}
.toast.show{opacity:1}
.log-toggle{background:none;border:none;color:#666;font-size:.8rem;cursor:pointer;padding:0;margin-bottom:10px;font-family:inherit}
.log-toggle:hover{color:#aaa;background:none}
</style>
</head>
<body>

<div class="breadcrumb"><a href="/">← Byse Stream Extractor v5</a> / stream</div>
<h1>🎬 ${esc(title)}</h1>

${videoId || dur ? `
<div class="meta-row">
  ${videoId ? `<div>Video ID: <span><code>${esc(videoId)}</code></span></div>` : ''}
  ${dur     ? `<div>Duration: <span>${esc(dur)}</span></div>` : ''}
  ${result?.meta?.views !== undefined ? `<div>Views: <span>${result.meta.views.toLocaleString()}</span></div>` : ''}
</div>` : ''}

${errMsg ? `<div class="err-box">⚠️ ${esc(errMsg)}</div>` : ''}

${m3u8 ? `
<div class="card">
  <h2>✅ Stream URL <span class="badge bok">M3U8 DECRYPTED</span></h2>

  <div class="m3u8-box" id="urlDisplay" onclick="copyUrl()" title="Click to copy">${esc(m3u8)}</div>

  ${all.length > 1 ? `<div class="cdns">${sourceButtons}</div>` : ''}

  <div class="btn-row">
    <button onclick="playInline()">▶ Play Inline</button>
    <button class="btn-outline" onclick="copyUrl()">📋 Copy URL</button>
    <button class="btn-outline" onclick="copyProxy()">📋 Copy Proxy URL</button>
    ${videoId ? `<a href="/playback?id=${esc(videoId)}" target="_blank" style="margin-left:auto"><button class="btn-copy" style="margin:0">🔍 Raw API</button></a>` : ''}
  </div>

  <div id="player"></div>
</div>
` : ''}

<div class="card">
  <h2>📋 Extraction Log <span class="badge benc">v5</span></h2>
  <button class="log-toggle" onclick="toggleLog()" id="logToggle">▼ Hide log</button>
  <div id="log">${logHtml}</div>
</div>

<div class="toast" id="toast">Copied!</div>

<script>
let currentUrl = ${JSON.stringify(m3u8 || '')};
let hls = null;
let logVisible = true;

function toggleLog() {
  const el = document.getElementById('log');
  const btn = document.getElementById('logToggle');
  logVisible = !logVisible;
  el.style.display = logVisible ? '' : 'none';
  btn.textContent = logVisible ? '▼ Hide log' : '▶ Show log';
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2000);
}

function setStream(url) {
  currentUrl = url;
  document.getElementById('urlDisplay').textContent = url;
  document.querySelectorAll('.cdn-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
}

function copyUrl() {
  navigator.clipboard.writeText(currentUrl).then(() => toast('URL copied!'));
}

function copyProxy() {
  const p = location.origin + '/proxy?url=' + encodeURIComponent(currentUrl);
  navigator.clipboard.writeText(p).then(() => toast('Proxy URL copied!'));
}

function playInline() {
  if (!currentUrl) return;
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  const proxy  = '/proxy?url=' + encodeURIComponent(currentUrl);
  const player = document.getElementById('player');
  player.innerHTML = '';
  const video  = document.createElement('video');
  video.controls = true;
  video.autoplay = true;
  player.appendChild(video);

  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = proxy;
  } else {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.7/hls.min.js';
    s.onload = () => {
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, lowLatencyMode: false });
        hls.loadSource(proxy);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (d.fatal) player.insertAdjacentHTML('beforeend',
            '<div class="err-box" style="margin-top:10px">HLS error: ' + d.details + '</div>');
        });
      }
    };
    document.head.appendChild(s);
  }
}

// Auto-scroll log to bottom
const logEl = document.getElementById('log');
if (logEl) logEl.scrollTop = logEl.scrollHeight;
</script>
</body>
</html>`;
}

// ── / — Web UI ────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Byse Stream Extractor v5</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#0f0f13;color:#e0e0e0;min-height:100vh;padding:24px}
h1{color:#fff;font-size:1.5rem;margin-bottom:4px}
.sub{color:#888;font-size:.85rem;margin-bottom:24px}
.card{background:#1a1a24;border:1px solid #2a2a3a;border-radius:12px;padding:20px;margin-bottom:16px}
label{display:block;font-size:.8rem;color:#aaa;margin-bottom:6px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
input{width:100%;background:#0f0f13;border:1px solid #333;border-radius:8px;padding:10px 14px;color:#fff;font-size:.95rem;outline:none;transition:border .2s}
input:focus{border-color:#6c63ff}
button{background:#6c63ff;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:.95rem;cursor:pointer;margin-top:12px;font-weight:600;transition:background .2s}
button:hover{background:#5a52dd}
button:disabled{background:#333;cursor:default}
.row{display:flex;gap:12px;flex-wrap:wrap}
.row>div{flex:1;min-width:180px}
#log{font-family:monospace;font-size:.78rem;background:#0a0a10;border:1px solid #222;border-radius:8px;padding:12px;max-height:320px;overflow-y:auto;white-space:pre-wrap;margin-top:12px;display:none;line-height:1.5}
.lo{color:#aaa}.ok{color:#7fdb7f}.er{color:#f87}.kk{color:#ffd97d}.sk{color:#ff9aff}
.stream-url{background:#0a0a10;border:1px solid #2a5a2a;border-radius:8px;padding:12px;font-family:monospace;font-size:.75rem;color:#7fdb7f;word-break:break-all;margin-bottom:10px}
.err-box{color:#f87;background:#1a0a0a;border:1px solid #422;border-radius:8px;padding:12px;font-size:.85rem;margin-top:12px}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.btn-sm{font-size:.8rem;padding:7px 14px;margin-top:0}
.btn-outline{background:transparent;border:1px solid #6c63ff;color:#6c63ff}
.btn-outline:hover{background:#6c63ff22}
video{width:100%;border-radius:8px;margin-top:12px;background:#000;max-height:480px}
h2{font-size:1rem;color:#ccc;margin-bottom:12px}
.sep{border:none;border-top:1px solid #2a2a3a;margin:16px 0}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:.72rem;font-weight:700;margin-left:6px;vertical-align:middle}
.benc{background:#1a1a3a;color:#7fa7ff;border:1px solid #2a2a6a}
.bok{background:#1a3a1a;color:#7fdb7f;border:1px solid #2a5a2a}
.bv5{background:#3a1a3a;color:#ff9aff;border:1px solid #6a2a6a}
.cdns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.cdn-btn{font-size:.72rem;padding:3px 10px;border-radius:4px;border:1px solid #333;color:#aaa;background:#0f0f13;cursor:pointer;transition:all .2s}
.cdn-btn:hover,.cdn-btn.active{border-color:#6c63ff;color:#9a9aff;background:#1a1a2a}
.debug-link{display:inline-block;margin-top:10px;color:#666;font-size:.8rem;text-decoration:none}
.debug-link:hover{color:#aaa}
.slug-hint{font-size:.75rem;color:#555;margin-top:6px}
</style>
</head>
<body>
<h1>🎬 Byse Stream Extractor <span class="badge benc">AES-256-GCM</span> <span class="badge bv5">v5</span></h1>
<p class="sub">key_parts concat → sprintcdn · edge_1+edge_2 concat → bysevideo · 50+ fallback strategies</p>

<div class="card">
  <h2>Extract by Video ID</h2>
  <div class="row">
    <div>
      <label>Video ID</label>
      <input id="vid" placeholder="e.g. o1xg2sltlrvd" value="o1xg2sltlrvd">
    </div>
    <div>
      <label>Page Referer (optional)</label>
      <input id="ref" placeholder="https://animenosub.to/" value="https://animenosub.to/">
    </div>
  </div>
  <button id="btnX" onclick="doExtract()">⚡ Extract Stream</button>
  <a class="debug-link" id="debugLink" href="/playback?id=o1xg2sltlrvd" target="_blank">🔍 Raw /playback JSON (decrypt preview)</a>
  <div id="log"></div>
</div>

<hr class="sep">

<div class="card">
  <h2>Extract by Episode Slug</h2>
  <label>animenosub.to Slug</label>
  <input id="slug" placeholder="rent-a-girlfriend-season-5-episode-2">
  <p class="slug-hint">Opens <strong>/stream/{slug}</strong> — scrapes the page, finds the Byse embed, decrypts automatically.</p>
  <button onclick="goSlug()">🔗 Open Stream Page</button>
</div>

<hr class="sep">

<div class="card">
  <h2>Paste CDN URL directly</h2>
  <label>m3u8 URL</label>
  <input id="cdnUrl" placeholder="https://edge1-vienna-sprintcdn.owphbf24.com/hls2/.../master.m3u8?t=…">
  <button onclick="useCdnUrl()">Use This URL</button>
</div>

<div id="result"></div>

<script>
let currentUrl = null, hls = null;

function colorLog(lines) {
  return lines.map(l => {
    if (l.includes('✅') || l.includes('SUCCESS'))    return '<span class="ok">'+esc(l)+'</span>';
    if (l.includes('❌') || l.includes('error'))      return '<span class="er">'+esc(l)+'</span>';
    if (l.includes('[key]') || l.includes('decrypt')) return '<span class="kk">'+esc(l)+'</span>';
    if (l.includes('[sign]') || l.includes('sprint')) return '<span class="sk">'+esc(l)+'</span>';
    return '<span class="lo">'+esc(l)+'</span>';
  }).join('\\n');
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function cdnLabel(u) {
  if (u.includes('sprintcdn') || u.includes('owphbf24')) return '🚀 sprintcdn';
  if (u.includes('bysevideo'))                           return '📦 bysevideo';
  return '🔗 CDN';
}

function goSlug() {
  const slug = document.getElementById('slug').value.trim();
  if (!slug) return;
  window.open('/stream/' + encodeURIComponent(slug), '_blank');
}

async function doExtract() {
  const id  = document.getElementById('vid').value.trim();
  const ref = document.getElementById('ref').value.trim();
  if (!id) return;
  const btn = document.getElementById('btnX');
  btn.disabled = true; btn.textContent = 'Extracting…';
  const logEl = document.getElementById('log');
  logEl.style.display = 'block'; logEl.innerHTML = '';
  document.getElementById('result').innerHTML = '';
  document.getElementById('debugLink').href = '/playback?id=' + encodeURIComponent(id);

  try {
    const qs  = '/extract?id=' + encodeURIComponent(id) + (ref ? '&referer=' + encodeURIComponent(ref) : '');
    const res  = await fetch(qs);
    const data = await res.json();
    if (data.log) logEl.innerHTML = colorLog(data.log);
    logEl.scrollTop = logEl.scrollHeight;
    if (data.success && data.url) {
      showStream(data.url, data.all || [data.url]);
    } else {
      document.getElementById('result').innerHTML =
        '<div class="err-box">⚠️ Extraction failed. See log above.<br><small>' + (data.message || '') + '</small></div>';
    }
  } catch (e) {
    document.getElementById('result').innerHTML = '<div class="err-box">Request failed: ' + esc(e.message) + '</div>';
  }
  btn.disabled = false; btn.textContent = '⚡ Extract Stream';
}

function useCdnUrl() {
  const url = document.getElementById('cdnUrl').value.trim();
  if (url) showStream(url, [url]);
}

function showStream(url, all) {
  currentUrl = url;
  const unique = [...new Set(all)];
  const badges = unique.map(u =>
    '<button class="cdn-btn' + (u === url ? ' active' : '') +
    '" onclick=\'showStream(' + JSON.stringify(u) + ',[' + JSON.stringify(u) + '])\'>' +
    cdnLabel(u) + '</button>'
  ).join('');

  document.getElementById('result').innerHTML = \`
<div class="card">
  <h2>✅ Stream Ready <span class="badge bok">DECRYPTED</span></h2>
  <div class="stream-url" id="streamUrlTxt">\${esc(url)}</div>
  <div class="cdns">\${badges}</div>
  <div class="btn-row">
    <button class="btn-sm" onclick="playInline()">▶ Play Inline</button>
    <button class="btn-sm btn-outline" onclick="navigator.clipboard.writeText(currentUrl)">📋 Copy URL</button>
    <button class="btn-sm btn-outline" onclick="navigator.clipboard.writeText(location.origin+'/proxy?url='+encodeURIComponent(currentUrl))">📋 Copy Proxy URL</button>
  </div>
  <div id="player"></div>
</div>\`;
}

function playInline() {
  const proxy = '/proxy?url=' + encodeURIComponent(currentUrl);
  document.getElementById('player').innerHTML = '';
  if (hls) { try { hls.destroy(); } catch {} hls = null; }
  const video = document.createElement('video');
  video.controls = true; video.autoplay = true;
  document.getElementById('player').appendChild(video);
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = proxy;
  } else {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.7/hls.min.js';
    s.onload = () => {
      if (Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(proxy);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(()=>{}));
        hls.on(Hls.Events.ERROR, (_, d) => {
          if (d.fatal) document.getElementById('player').insertAdjacentHTML('beforeend',
            '<div class="err-box">HLS error: ' + esc(d.details) + '</div>');
        });
      }
    };
    document.head.appendChild(s);
  }
}
</script>
</body>
</html>`);
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎬 Byse Stream Server v5 — http://localhost:${PORT}\n`);
  console.log(`  GET /                              Web UI`);
  console.log(`  GET /extract?id=ID                 Auto-extract stream URL`);
  console.log(`  GET /extract?id=ID&referer=URL     With custom referer`);
  console.log(`  GET /playback?id=ID                Raw API + decrypt preview`);
  console.log(`  GET /proxy?url=M3U8_URL            Reverse-proxy + rewrite m3u8`);
  console.log(`  GET /segment?url=SEG_URL           Proxy TS segments`);
  console.log(`  GET /stream/:slug                  Scrape slug → stream page\n`);
  console.log(`  Decrypt strategies:`);
  console.log(`    A) key_parts[0]+key_parts[1] concat (base64url) → payload1  → sprintcdn ✅`);
  console.log(`    B) edge_1+edge_2 concat (base64url)             → payload2  → bysevideo ✅`);
  console.log(`    C) 50+ generic fallback candidates\n`);
});