/**
 * kuudere-scraper.js
 *
 * Real flow (reverse-engineered from network traffic + official kuudere API docs):
 *
 *  1.  POST kuudere.to/register
 *        → { session: { session, sessionId, expire } }
 *
 *  2.  POST kuudere.to/get_episode_links
 *        body: { key: session, secret: sessionId, anime_id, episode_id: <ep number> }
 *        → { episode_links: [ { serverName, dataLink, dataType, ... } ] }
 *
 *  3.  Pick the Zen / Zen-2 dataLink  (e.g. https://kuudere.to/player/Zen/<slug>?...)
 *
 *  4.  GET that player page
 *        → HTML contains: video_b64, key_frag, zencloudz video ID
 *
 *  5.  POST https://zencloudz.cc/api/m3u8/<videoId>
 *        body: { video_b64, key_frag, <obfuscated tokens>, metadata }
 *        → { sources: [ { file: "https://repackager.wixmp.com/...m3u8" } ] }
 *           OR the .m3u8 URL is returned directly as a string
 */

const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const crypto  = require('crypto');

const app  = express();
const PORT = 3000;
const BASE = 'https://kuudere.to';

// ── Session cache ─────────────────────────────────────────────────────────────
let SESSION = null;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function browserHeaders(extra = {}) {
  return {
    'User-Agent'     : BROWSER_UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer'        : `${BASE}/`,
    'Origin'         : BASE,
    ...extra,
  };
}

// ── 1. Auth ───────────────────────────────────────────────────────────────────

async function register() {
  const rnd  = crypto.randomBytes(5).toString('hex');
  const user = `u${rnd}`;
  const pass = crypto.randomBytes(8).toString('hex');

  console.log(`[auth] Registering ${user}...`);

  const { data } = await axios.post(`${BASE}/register`, {
    email    : `${user}@tmpmail.dev`,
    username : user,
    password : pass,
  }, { headers: browserHeaders({ 'Content-Type': 'application/json' }) });

  if (!data.success) throw new Error(`Register failed: ${JSON.stringify(data)}`);

  return {
    key    : data.session.session,
    secret : data.session.sessionId,
    expire : data.session.expire,
  };
}

async function getSession() {
  if (SESSION && new Date(SESSION.expire) > new Date()) return SESSION;
  SESSION = await register();
  console.log(`[auth] Session OK, expires ${SESSION.expire}`);
  return SESSION;
}

// ── 2. Episode links ──────────────────────────────────────────────────────────

async function getEpisodeLinks(animeId, episodeNumber) {
  const { key, secret } = await getSession();

  console.log(`[api] get_episode_links  anime=${animeId}  ep=${episodeNumber}`);

  const { data } = await axios.post(`${BASE}/get_episode_links`, {
    key,
    secret,
    anime_id  : animeId,
    episode_id: episodeNumber,   // kuudere accepts the episode number directly
  }, { headers: browserHeaders({ 'Content-Type': 'application/json' }) });

  if (!data.success) throw new Error(`get_episode_links: ${JSON.stringify(data)}`);

  return data.episode_links || [];
}

// ── 3. Pick best server ───────────────────────────────────────────────────────

function pickLink(links, wantServer, wantLang) {
  const n = s => (s || '').toLowerCase().trim();
  const sv = n(wantServer);
  const lg = n(wantLang);

  return (
    // exact match
    links.find(l => n(l.serverName) === sv && n(l.dataType) === lg) ||
    // strip trailing -N from server name
    links.find(l => n(l.serverName).replace(/-\d+$/, '') === sv.replace(/-\d+$/, '') && n(l.dataType) === lg) ||
    // any Zen + lang
    links.find(l => n(l.serverName).startsWith('zen') && n(l.dataType) === lg) ||
    // any Zen
    links.find(l => n(l.serverName).startsWith('zen')) ||
    // first available
    links[0] ||
    null
  );
}

// ── 4. Fetch player page & extract zencloudz payload ─────────────────────────

async function extractPlayerData(playerUrl) {
  console.log(`[player] GET ${playerUrl}`);

  const { data: html } = await axios.get(playerUrl, {
    headers     : browserHeaders({ Accept: 'text/html,*/*' }),
    maxRedirects: 5,
  });

  const $ = cheerio.load(html);

  // The player page embeds the zencloudz payload as a JS object or JSON in a <script> tag.
  // Patterns seen in the wild:
  //   var playerData = { video_b64: "...", key_frag: "...", videoId: "..." };
  //   window.__PLAYER_DATA__ = { ... };
  //   const d = JSON.parse('{"video_b64":"..."}');

  let playerData = null;

  $('script').each((_, el) => {
    const src = $(el).html() || '';

    // Try to find a JSON blob containing video_b64
    const jsonMatch = src.match(/\{[^{}]*"video_b64"\s*:\s*"[^"]+[^{}]*\}/s);
    if (jsonMatch) {
      try {
        playerData = JSON.parse(jsonMatch[0]);
        return false; // break
      } catch (_) {}
    }

    // Try individual variable assignments
    if (!playerData) {
      const vb64  = src.match(/['"]{0,1}video_b64['"]{0,1}\s*[=:]\s*["']([^"']+)["']/);
      const kfrag = src.match(/['"]{0,1}key_frag['"]{0,1}\s*[=:]\s*["']([^"']+)["']/);
      const vidId = src.match(/['"]{0,1}(?:videoId|video_id|vid_id|id)['"]{0,1}\s*[=:]\s*["']([a-f0-9]{20,})["']/);

      if (vb64 && kfrag) {
        playerData = {
          video_b64: vb64[1],
          key_frag : kfrag[1],
          videoId  : vidId ? vidId[1] : null,
        };

        // Also try to grab obfuscated token fields
        const tok1 = src.match(/["']([a-z0-9]{10,12})["']\s*:\s*["']([0-9]+\.[a-z0-9]+)["']/);
        const tok2 = src.match(/["']([a-z0-9]{10,12})["']\s*:\s*["']([a-z]{8,15})["']/);
        const tok3 = src.match(/["']([a-z0-9]{10,12})["']\s*:\s*["']([0-9]{13})["']/);
        if (tok1) playerData[tok1[1]] = tok1[2];
        if (tok2) playerData[tok2[1]] = tok2[2];
        if (tok3) playerData[tok3[1]] = tok3[2];

        return false;
      }
    }
  });

  if (!playerData) {
    // Last resort: dump all script content for debugging
    const scriptDump = $('script').map((_, el) => $(el).html()).get().join('\n').slice(0, 2000);
    throw new Error(`Could not extract player data from ${playerUrl}.\nScript preview:\n${scriptDump}`);
  }

  // Extract the zencloudz video ID from the player URL or page
  if (!playerData.videoId) {
    // Check for zencloudz fetch URL in scripts
    const zenMatch = html.match(/zencloudz\.cc\/api\/m3u8\/([a-f0-9]{20,})/);
    if (zenMatch) playerData.videoId = zenMatch[1];
  }

  if (!playerData.videoId) {
    throw new Error('Could not find zencloudz video ID in player page');
  }

  console.log(`[player] Got video_b64, key_frag, videoId=${playerData.videoId}`);
  return playerData;
}

// ── 5. Call zencloudz API ─────────────────────────────────────────────────────

async function callZencloudz(playerData, playerUrl) {
  const { videoId, video_b64, key_frag, ...rest } = playerData;

  // Reconstruct the exact payload sent by kuudere's player
  // Based on the captured network request:
  // { video_b64, key_frag, 5apo0k5l1xx, ffq99upd3x, n4ac0vr1pae, metadata: { timestamp, version } }
  const ts = Date.now().toString();
  const payload = {
    video_b64,
    key_frag,
    ...rest,         // includes obfuscated token fields if extracted
    metadata: {
      timestamp: parseInt(ts),
      version  : '2.1',
    },
  };

  console.log(`[zencloudz] POST https://zencloudz.cc/api/m3u8/${videoId}`);

  const { data } = await axios.post(
    `https://zencloudz.cc/api/m3u8/${videoId}`,
    payload,
    {
      headers: {
        ...browserHeaders({
          'Content-Type': 'application/json',
          'Referer'     : playerUrl,
          'Origin'      : BASE,
        }),
      },
    }
  );

  console.log(`[zencloudz] Response:`, JSON.stringify(data).slice(0, 300));

  // Response formats seen:
  // { sources: [ { file: "https://repackager.wixmp.com/...m3u8", label, type } ] }
  // { url: "https://..." }
  // { stream: "https://..." }
  // { link: "https://..." }

  if (data.sources && data.sources[0]?.file) return data.sources[0].file;
  if (data.url)    return data.url;
  if (data.stream) return data.stream;
  if (data.link)   return data.link;

  // Maybe it's a direct string
  if (typeof data === 'string' && data.includes('.m3u8')) return data;

  // Scan for any .m3u8 URL in the response
  const str  = JSON.stringify(data);
  const m    = str.match(/https?:\\?\/\\?\/[^\s"'\\]+\.m3u8[^\s"'\\]*/);
  if (m) return m[0].replace(/\\\//g, '/');

  throw new Error(`zencloudz returned no stream URL: ${str.slice(0, 500)}`);
}

// ── Parse watch URL ───────────────────────────────────────────────────────────

function parseWatchUrl(watchUrl) {
  const u     = new URL(watchUrl);
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'watch' || parts.length < 3) {
    throw new Error(`Bad URL format: ${watchUrl}`);
  }
  return {
    animeId : parts[1],
    epNum   : parseInt(parts[2], 10),
    server  : u.searchParams.get('server') || 'Zen-2',
    lang    : u.searchParams.get('lang')   || 'sub',
  };
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function extractStream(watchUrl) {
  const { animeId, epNum, server, lang } = parseWatchUrl(watchUrl);
  console.log(`\n── ${watchUrl}`);

  // Step 1+2: get episode links
  const links = await getEpisodeLinks(animeId, epNum);
  if (!links.length) throw new Error('No episode links returned');
  console.log(`[links] ${links.map(l => `${l.serverName}(${l.dataType})`).join(', ')}`);

  // Step 3: pick server
  const chosen = pickLink(links, server, lang);
  if (!chosen) throw new Error('No suitable server found');
  console.log(`[pick] ${chosen.serverName} (${chosen.dataType}) → ${chosen.dataLink}`);

  // If dataLink is already a direct .m3u8
  if (/\.m3u8/i.test(chosen.dataLink)) return { streamUrl: chosen.dataLink };

  // Step 4: fetch player page
  const playerData = await extractPlayerData(chosen.dataLink);

  // Step 5: call zencloudz
  const streamUrl = await callZencloudz(playerData, chosen.dataLink);

  return {
    streamUrl,
    server    : chosen.serverName,
    lang      : chosen.dataType,
    playerUrl : chosen.dataLink,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/stream', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });
  try {
    res.json({ success: true, ...(await extractStream(url)) });
  } catch (e) {
    console.error('[error]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/stream/all', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });
  try {
    const { animeId, epNum } = parseWatchUrl(url);
    const links = await getEpisodeLinks(animeId, epNum);
    res.json({ success: true, count: links.length, links });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/proxy-stream', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url= parameter' });
  try {
    const { streamUrl } = await extractStream(url);
    res.redirect(302, streamUrl);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', (_, res) => res.json({
  endpoints: {
    stream   : 'GET /stream?url=<watch-url>',
    allLinks : 'GET /stream/all?url=<watch-url>',
    redirect : 'GET /proxy-stream?url=<watch-url>',
  },
  example: '/stream?url=https://kuudere.to/watch/677f1387001c5de2ba68/1?lang=sub',
}));

app.listen(PORT, () => console.log(`\n🎬  http://localhost:${PORT}\n`));