const express = require("express");
const axios = require("axios");

const app = express();
const BASE = "https://senshi.live";

const streamHeaders = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Origin": BASE,
  "Referer": BASE + "/",
  "Accept": "*/*",
};

// ── Session factory ───────────────────────────────────────────────────────────
function createSession() {
  let sessionCookies = "";
  const http = axios.create({ timeout: 15000, maxRedirects: 5 });
  http.interceptors.response.use((res) => {
    const sc = res.headers["set-cookie"];
    if (sc) sessionCookies = sc.map((c) => c.split(";")[0]).join("; ");
    return res;
  });

  const browserHeaders = (referer = BASE + "/", extra = {}) => ({
    "User-Agent": streamHeaders["User-Agent"],
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.7",
    "Referer": referer,
    "Origin": BASE,
    "Cookie": sessionCookies,
    ...extra,
  });

  async function get(url, referer, extra = {}) {
    console.log("[GET]", url);
    const { data } = await http.get(url, { headers: browserHeaders(referer, extra) });
    return data;
  }

  return { get, http };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function findAllM3u8s(text) {
  if (typeof text !== "string") text = JSON.stringify(text);
  const found = new Set();
  for (const m of text.matchAll(/https?:\/\/[^\s"'`\\]+\.m3u8[^\s"'`\\]*/g)) found.add(m[0]);
  for (const [, val] of text.matchAll(/"(?:file|src|source|stream|url|embed|link)"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/g)) found.add(val);
  for (const [, b64] of text.matchAll(/atob\(["'`]([A-Za-z0-9+/=]{20,})["'`]\)/g)) {
    try { for (const u of findAllM3u8s(Buffer.from(b64, "base64").toString())) found.add(u); } catch {}
  }
  return [...found];
}

function findAllEmbedUrls(obj) {
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  const urls = new Set();
  for (const [, u] of raw.matchAll(/["'](https?:\/\/[^"'\s]{10,})["']/g)) {
    if (u.includes("ninstream") || u.includes("ninjstream") || u.includes("embed") || u.includes("player") || u.includes("stream"))
      urls.add(u);
  }
  return [...urls];
}

function parseWatchUrl(url) {
  const match = url.match(/\/watch\/([^/]+)\/(\d+)/);
  if (!match) return null;
  return { slug: match[1], episode: match[2] };
}

function normaliseLabel(raw = "") {
  const s = raw.toLowerCase();
  if (s.includes("dubbed") || s.includes("dub") || s.includes("english") || s.includes("eng")) return "dub";
  if (s.includes("hardsub") || s.includes("softsub") || s.includes("subbed") ||
      s.includes("sub") || s.includes("japanese") || s.includes("jpn") ||
      s.includes("soft") || s.includes("hard")) return "sub";
  return s || null;
}

function detectLabelFromEmbed(url = "", html = "") {
  const haystack = (url + " " + (typeof html === "string" ? html : JSON.stringify(html))).toLowerCase();
  if (haystack.includes("dubbed"))  return "dub";
  if (haystack.includes("subbed") || haystack.includes("softsub") || haystack.includes("hardsub")) return "sub";
  if (haystack.includes("dub"))     return "dub";
  if (haystack.includes("sub"))     return "sub";
  return null;
}

// ── Resolve slug → numeric anime ID ──────────────────────────────────────────
async function resolveAnimeId(slug, referer, get) {
  try {
    const data = await get(`${BASE}/anime/${slug}`, referer);
    const id = data?.id ?? data?.mal_id ?? data?.anime_id;
    if (id) {
      console.log(`[ID] ${slug} → ${id}`);
      return { numericId: String(id), animeData: data };
    }
  } catch (e) {
    console.log("[ID] resolve failed:", e.response?.status || e.message);
  }
  return { numericId: null, animeData: null };
}

// ── Fetch episode list ────────────────────────────────────────────────────────
async function fetchEpisodeList(numericId, slug, referer, get) {
  const data = await get(`${BASE}/episodes/${numericId}`, referer);
  const list = Array.isArray(data)
    ? data
    : data?.episodes || data?.data || data?.results || [];

  return list.map((ep) => {
    const epId = ep.ep_id ?? ep.episode_number ?? ep.number ?? ep.id;
    return {
      number:    epId,
      episodeId: `${slug}/${epId}`,
      watchUrl:  `/watch/${slug}/${epId}`,
      title:     ep.ep_title || ep.title || `Episode ${epId}`,
      url:       `${BASE}/watch/${slug}/${epId}`,
      available: ep.available !== false && ep.hidden !== true,
    };
  }).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

// ── Collect all m3u8 URLs ─────────────────────────────────────────────────────
async function collectAllStreams(numericId, episode, referer, get) {
  const EXTRA = { "X-Requested-With": "XMLHttpRequest" };
  const allM3u8s = new Map();

  let rawData = null;
  try {
    rawData = await get(`${BASE}/episode-embeds/${numericId}/${episode}`, referer, EXTRA);
    console.log("[RAW]", JSON.stringify(rawData).slice(0, 500));
  } catch (e) {
    console.log("[RAW] Failed:", e.response?.status);
    return allM3u8s;
  }

  const list = Array.isArray(rawData)
    ? rawData
    : rawData?.sources || rawData?.embeds || rawData?.data ||
      rawData?.results || rawData?.videos || rawData?.streams || [];

  if (list.length > 0) {
    for (const entry of list) {
      // ← entry.status is the key field ("Dub", "HardSub", etc.)
      const label = normaliseLabel(
        entry.status   || entry.label    || entry.title    || entry.type     ||
        entry.lang     || entry.language || entry.audio    ||
        entry.name     || entry.kind     || entry.category ||
        entry.group    || entry.track    || entry.version  || ""
      );
      for (const u of findAllM3u8s(entry)) { if (!allM3u8s.has(u)) allM3u8s.set(u, label); }
      for (const eu of findAllEmbedUrls(entry)) {
        if ([...allM3u8s.keys()].some((k) => k.includes(eu))) continue;
        try {
          const html = await get(eu, referer);
          const embedLabel = label || detectLabelFromEmbed(eu, html);
          for (const u of findAllM3u8s(html)) { if (!allM3u8s.has(u)) allM3u8s.set(u, embedLabel); }
        } catch (e) { console.log("[EMBED]", eu, "→", e.message); }
      }
    }
  }

  const embedUrls = findAllEmbedUrls(rawData);
  for (const eu of embedUrls) {
    try {
      const html = await get(eu, referer);
      const embedLabel = detectLabelFromEmbed(eu, html);
      for (const u of findAllM3u8s(html)) {
        if (!allM3u8s.has(u)) {
          allM3u8s.set(u, embedLabel);
          console.log("[FOUND]", u, "→", embedLabel || "unlabelled");
        }
      }
    } catch (e) { console.log("[EMBED]", eu, "→", e.message); }
  }

  for (const u of findAllM3u8s(rawData)) { if (!allM3u8s.has(u)) allM3u8s.set(u, null); }

  return allM3u8s;
}

// ── Build stream result ───────────────────────────────────────────────────────
function buildStreamResult(allM3u8s) {
  const result = {};
  const unlabelled = [];

  for (const [m3u8, label] of allM3u8s) {
    if (label) {
      if (!result[label]) result[label] = m3u8;
      else unlabelled.push(m3u8);
    } else {
      unlabelled.push(m3u8);
    }
  }

  const taken = new Set(Object.values(result));
  let idx = 0;
  for (const m3u8 of unlabelled) {
    if (taken.has(m3u8)) continue;
    result[`source_${idx++}`] = m3u8;
    taken.add(m3u8);
  }

  return result;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
async function setup(slug, episode) {
  const referer = `${BASE}/watch/${slug}/${episode}`;
  const { get, http } = createSession();
  try {
    await http.get(`${BASE}/watch/${slug}/${episode}`, {
      headers: { "User-Agent": streamHeaders["User-Agent"], Accept: "text/html,*/*" },
    });
  } catch (e) { console.log("[SESSION]", e.response?.status || e.message); }

  const { numericId, animeData } = await resolveAnimeId(slug, referer, get);
  return { get, http, referer, numericId, animeData };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    message: 'Anime Scraper API',
    version: '1.2.0',
       episodes:  { base: '/episodes/8lead' },
      watch:  { base: '/watch/8lead/1' },
      
   });
});
// GET /episodes/:slug
app.get("/episodes/:slug", async (req, res) => {
  const { slug } = req.params;
  const onlyAvailable = req.query.available === "1";
  const episode = "1";
  const referer = `${BASE}/watch/${slug}/${episode}`;
  const report = { slug, referer };

  try {
    const { get, http, numericId, animeData } = await setup(slug, episode);

    try {
      await http.get(`${BASE}/watch/${slug}/${episode}`, {
        headers: { "User-Agent": streamHeaders["User-Agent"], Accept: "text/html,*/*" },
      });
      report.sessionWarmed = true;
    } catch (e) {
      report.sessionWarmed = false;
    }

    report.numericId  = numericId;
    report.animeTitle = animeData?.title;
    report.animeData  = animeData;

    if (!numericId)
      return res.status(502).json({ ...report, error: `Could not resolve anime ID for slug "${slug}"` });

    let episodes = await fetchEpisodeList(numericId, slug, referer, get);
    if (onlyAvailable) episodes = episodes.filter((ep) => ep.available);

    res.json({
      ...report,
      title:    animeData?.title || slug,
      total:    episodes.length,
      episodes,
    });
  } catch (err) {
    res.status(500).json({ ...report, error: err.message });
  }
});

// GET /watch/:slug/:episode
app.get("/watch/:slug/:episode", async (req, res) => {
  const { slug, episode } = req.params;
  const type = req.query.type;

  try {
    const { get, numericId, referer } = await setup(slug, episode);
    if (!numericId) return res.status(502).json({ error: `Could not resolve anime ID for slug "${slug}"` });

    const allM3u8s = await collectAllStreams(numericId, episode, referer, get);
    const streams = buildStreamResult(allM3u8s);

    if (!Object.keys(streams).length) return res.json({ error: "No streams found" });

    if (type) {
      const m3u8 = streams[type];
      if (!m3u8) return res.json({ error: `No "${type}" stream`, available: Object.keys(streams) });
      return res.json({ type, m3u8, proxy: `/proxy-m3u8?url=${encodeURIComponent(m3u8)}` });
    }

    const out = {};
    for (const [label, m3u8] of Object.entries(streams))
      out[label] = { m3u8, proxy: `/proxy-m3u8?url=${encodeURIComponent(m3u8)}` };
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /scrape-all-episodes
app.get("/scrape-all-episodes", async (req, res) => {
  const url = req.query.url || `${BASE}/watch/ru76k/1`;
  const parsed = parseWatchUrl(url);
  if (!parsed) return res.status(400).json({ error: "Bad URL" });

  const { slug, episode } = parsed;
  try {
    const { get, numericId, animeData, referer } = await setup(slug, episode);
    if (!numericId) return res.status(502).json({ error: `Could not resolve anime ID for slug "${slug}"` });

    const [episodes, allM3u8s] = await Promise.all([
      fetchEpisodeList(numericId, slug, referer, get).catch((e) => { console.log("[EPISODES]", e.message); return []; }),
      collectAllStreams(numericId, episode, referer, get),
    ]);

    const streams = buildStreamResult(allM3u8s);
    const streamOut = {};
    for (const [label, m3u8] of Object.entries(streams))
      streamOut[label] = { m3u8, proxy: `/proxy-m3u8?url=${encodeURIComponent(m3u8)}` };

    res.json({ slug, numericId, title: animeData?.title || slug, currentEpisode: parseInt(episode, 10), streams: streamOut, total: episodes.length, episodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /diagnose
app.get("/diagnose", async (req, res) => {
  const url = req.query.url || `${BASE}/watch/ru76k/1`;
  const parsed = parseWatchUrl(url);
  if (!parsed) return res.status(400).json({ error: "Bad URL" });

  const { slug, episode } = parsed;
  const referer = `${BASE}/watch/${slug}/${episode}`;
  const report = { slug, episode, referer };

  const { get, http } = createSession();

  try {
    await http.get(`${BASE}/watch/${slug}/${episode}`, {
      headers: { "User-Agent": streamHeaders["User-Agent"], Accept: "text/html,*/*" },
    });
    report.sessionWarmed = true;
  } catch (e) {
    report.sessionWarm = { error: e.response?.status || e.message };
  }

  const { numericId, animeData } = await resolveAnimeId(slug, referer, get);
  report.numericId  = numericId;
  report.animeTitle = animeData?.title;
  report.animeData  = animeData;

  if (!numericId) {
    report.fatal = "Could not resolve numeric ID — all embed calls skipped";
    return res.json(report);
  }

  try {
    const rawEpisodes = await get(`${BASE}/episodes/${numericId}`, referer);
    const list = Array.isArray(rawEpisodes) ? rawEpisodes : rawEpisodes?.episodes || rawEpisodes?.data || rawEpisodes?.results || [];
    report.episodeList = {
      endpoint:      `${BASE}/episodes/${numericId}`,
      totalReturned: list.length,
      first5raw:     list.slice(0, 5),
      first5parsed:  list.slice(0, 5).map((ep) => ({
        ep_id:          ep.ep_id,
        episode_number: ep.episode_number,
        number:         ep.number,
        id:             ep.id,
        ep_title:       ep.ep_title,
        title:          ep.title,
        available:      ep.available,
        hidden:         ep.hidden,
      })),
    };
  } catch (e) {
    report.episodeList = { error: e.response?.status || e.message };
  }

  const epIdsToTry = new Set([episode]);
  if (report.episodeList?.first5parsed?.length) {
    const firstEpId = report.episodeList.first5parsed[0]?.ep_id
      ?? report.episodeList.first5parsed[0]?.episode_number;
    if (firstEpId && String(firstEpId) !== episode) epIdsToTry.add(String(firstEpId));
  }

  report.embedProbes = {};

  for (const epId of epIdsToTry) {
    const embedUrl = `${BASE}/episode-embeds/${numericId}/${epId}`;
    const probe = { url: embedUrl };

    try {
      const EXTRA = { "X-Requested-With": "XMLHttpRequest" };
      const raw = await get(embedUrl, referer, EXTRA);

      probe.rawResponse    = raw;
      probe.rawType        = Array.isArray(raw) ? "array" : typeof raw;
      probe.rawLength      = Array.isArray(raw) ? raw.length : (typeof raw === "string" ? raw.length : Object.keys(raw || {}).length);
      probe.rawStringified = JSON.stringify(raw).slice(0, 2000);
      probe.m3u8sDirect    = findAllM3u8s(raw);
      probe.embedUrlsFound = findAllEmbedUrls(raw);

      probe.embedFollowResults = {};
      for (const eu of probe.embedUrlsFound) {
        try {
          const html = await get(eu, referer);
          probe.embedFollowResults[eu] = {
            detectedLabel: detectLabelFromEmbed(eu, html),
            m3u8s:         findAllM3u8s(html),
            snippet:       String(html).slice(0, 500),
          };
        } catch (e) {
          probe.embedFollowResults[eu] = { error: e.response?.status || e.message };
        }
      }
    } catch (e) {
      probe.error        = e.message;
      probe.status       = e.response?.status;
      probe.responseBody = e.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : null;
    }

    report.embedProbes[epId] = probe;
  }

  res.json(report);
});

// ── Proxy ─────────────────────────────────────────────────────────────────────
app.get("/proxy-m3u8", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing ?url=");
  try {
    const { data } = await axios.get(url, { headers: streamHeaders, responseType: "text", timeout: 10000 });
    const base = new URL(url);
    const rewritten = data.replace(/^(?!#)(\S+)$/gm, (line) => {
      const abs = line.startsWith("http") ? line : new URL(line, base).href;
      return abs.includes(".m3u8")
        ? `/proxy-m3u8?url=${encodeURIComponent(abs)}`
        : `/proxy-segment?url=${encodeURIComponent(abs)}`;
    });
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(rewritten);
  } catch (err) { res.status(500).send(err.message); }
});

app.get("/proxy-segment", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing ?url=");
  try {
    const { data, headers } = await axios.get(url, { headers: streamHeaders, responseType: "arraybuffer", timeout: 20000 });
    res.set("Content-Type", headers["content-type"] || "video/mp2t");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(data);
  } catch (err) { res.status(500).send(err.message); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(3000, () => {
  console.log("→ /episodes/:slug         http://localhost:3000/episodes/d02k8");
  console.log("→ /watch/:slug/:episode   http://localhost:3000/watch/d02k8/1");
  console.log("→ /scrape-all-eps         http://localhost:3000/scrape-all-episodes?url=https://senshi.live/watch/d02k8/1");
  console.log("→ /diagnose               http://localhost:3000/diagnose?url=https://senshi.live/watch/d02k8/1");
});