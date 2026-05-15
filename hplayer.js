const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const he = require("he");

const app = express();
app.use(cors());

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function decodeUnicode(str) {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  );
}

function fixUrl(url) {
  if (!url) return url;
  url = url.replace(/^(https?):\/\/\/+/, "$1://");
  if (url.startsWith("//")) url = "https:" + url;
  return url;
}

function isAbsoluteUrl(url) {
  return /^https?:\/\/.+/.test(url);
}

function parseTagAttrs(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

async function fetchMasterPlaylist(masterUrl, referer, debug) {
  try {
    debug.push(`[M] Fetching master m3u8: ${masterUrl}`);
    const { data: m3u8Text } = await axios.get(masterUrl, {
      headers: {
        ...HEADERS,
        Referer: referer,
        Origin: "https://kaa.lt",
        "x-origin": "KAA-Cat-Stream",
      },
      responseType: "text",
    });

    debug.push(`[M] Raw m3u8 content:\n${m3u8Text}`);

    const base = new URL(masterUrl);
    const audio = [];
    const video = [];

    function resolve(token) {
      token = token.trim();
      if (/^https?:\/\//.test(token)) return token;
      if (token.startsWith("//")) return "https:" + token;
      if (token.startsWith("/")) return `${base.protocol}//${base.host}${token}`;
      const dir = masterUrl.substring(0, masterUrl.lastIndexOf("/") + 1);
      return dir + token;
    }

    const lines = m3u8Text.split(/\r?\n|\r/);
    let pendingStreamInf = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith("#EXT-X-MEDIA:")) {
        const attrs = parseTagAttrs(trimmed);
        if (attrs.URI) {
          audio.push({
            url:      resolve(attrs.URI),
            type:     attrs.TYPE        || "AUDIO",
            name:     attrs.NAME        || "",
            language: attrs.LANGUAGE    || "",
            groupId:  attrs["GROUP-ID"] || "",
            default:  attrs.DEFAULT === "YES",
          });
        }
        pendingStreamInf = null;
        continue;
      }

      if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
        pendingStreamInf = parseTagAttrs(trimmed);
        continue;
      }

      if (trimmed.startsWith("#")) {
        pendingStreamInf = null;
        continue;
      }

      const url = resolve(trimmed);
      const inf = pendingStreamInf || {};
      const [w, h] = (inf.RESOLUTION || "x").split("x");
      video.push({
        url,
        bandwidth:  parseInt(inf.BANDWIDTH || "0", 10),
        resolution: inf.RESOLUTION || "",
        width:      parseInt(w || "0", 10),
        height:     parseInt(h || "0", 10),
        frameRate:  parseFloat(inf["FRAME-RATE"] || "0"),
        codecs:     inf.CODECS || "",
        audioGroup: inf.AUDIO  || "",
      });
      pendingStreamInf = null;
    }

    video.sort((a, b) => b.height - a.height);
    debug.push(`[M] Audio tracks: ${audio.length} | Video tracks: ${video.length}`);
    return { audio, video };
  } catch (e) {
    debug.push(`[M] Failed to fetch master m3u8: ${e.message}`);
    return { audio: [], video: [] };
  }
}

function extractAstroProps(html) {
  const $ = cheerio.load(html);
  const results = [];
  $("astro-island[props]").each((_, el) => {
    try {
      const raw = $(el).attr("props") || "";
      const decoded = he.decode(decodeUnicode(raw));
      results.push(JSON.parse(decoded));
    } catch (_e) {}
  });
  $("script[type='application/json']").each((_, el) => {
    try {
      const raw = $(el).html() || "";
      const decoded = he.decode(decodeUnicode(raw));
      results.push(JSON.parse(decoded));
    } catch (_e) {}
  });
  return results;
}

function collectStrings(obj, pattern, found = []) {
  if (typeof obj === "string") {
    if (pattern.test(obj)) found.push(obj);
  } else if (Array.isArray(obj)) {
    for (const v of obj) collectStrings(v, pattern, found);
  } else if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) collectStrings(v, pattern, found);
  }
  return found;
}

// ─── Extract show slug from either show URL or episode URL ───────────────────
function extractShowSlug(url) {
  // Episode URL: /one-piece-0948/ep-95-dcb4b7  → one-piece-0948
  // Show URL:    /one-piece-0948                → one-piece-0948
  const m = url.match(/kaa\.lt\/([a-z0-9-]+?)(?:\/ep-|$|\?)/i);
  return m ? m[1] : null;
}

// ─── / ───────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "KAA Scraper API",
    routes: [
      {
        method: "GET",
        path: "/",
        description: "List all routes",
        example: "http://localhost:3000/",
      },
      {
        method: "GET",
        path: "/info",
        description: "Get show info, episode list, sub/dub options and page ranges. Accepts show URL or episode URL.",
        params: {
          url: "kaa.lt show or episode URL (required)",
          page: "Page number for episode list, default 1",
          lang: "Language code, default ja-JP",
        },
        examples: [
          "/info?url=https://kaa.lt/one-piece-0948&page=1",
          "http://localhost:3000/info?url=https://kaa.lt/one-piece-0948&page=2",
          "http://localhost:3000/info?url=https://kaa.lt/one-piece-0948/ep-95-dcb4b7&page=1",
          "http://localhost:3000/info?url=https://kaa.lt/one-piece-0948&lang=en-US&page=1",
        ],
      },
      {
        method: "GET",
        path: "/scrape",
        description: "Scrape m3u8, audio, video tracks and subtitles from a kaa.lt episode page.",
        params: {
          url: "kaa.lt episode URL (required)",
        },
        examples: [
          "http://localhost:3000/scrape?url=https://kaa.lt/one-piece-0948/ep-1-225ebd",
          "http://localhost:3000/scrape?url=https://kaa.lt/one-piece-0948/ep-95-dcb4b7",
        ],
      },
      {
        method: "GET",
        path: "/playlist",
        description: "Proxy and return a raw m3u8 master playlist with correct CORS headers.",
        params: {
          url: "master.m3u8 URL (required)",
        },
        examples: [
          "http://localhost:3000/playlist?url=https://bl.krussdomi.com/playlist/679705bd169c31976bd92812/master.m3u8",
        ],
      },
      {
        method: "GET",
        path: "/proxy",
        description: "Proxy any HLS segment or sub-playlist stream.",
        params: {
          url: "segment or playlist URL (required)",
        },
        examples: [
          "http://localhost:3000/proxy?url=https://bl.krussdomi.com/playlist/679705bd169c31976bd92812/679705bdd2c77260213329fc/playlist.m3u8",
          "http://localhost:3000/proxy?url=https://bl.krussdomi.com/playlist/679705bd169c31976bd92812/679705bdd2c7726021332a08/playlist.m3u8",
        ],
      },
      {
        method: "GET",
        path: "/vtt",
        description: "Proxy and return a VTT subtitle file with correct CORS and content-type headers.",
        params: {
          url: "VTT subtitle URL (required)",
        },
        examples: [
          "http://localhost:3000/vtt?url=https://bl1.advancedairesearchlab.xyz/679705bd169c31976bd92812/preview-4koE-.vtt",
        ],
      },
      {
        method: "GET",
        path: "/debug-master",
        description: "Fetch and return the raw text content of a master m3u8 for inspection.",
        params: {
          url: "master.m3u8 URL (required)",
        },
        examples: [
          "http://localhost:3000/debug-master?url=https://bl.krussdomi.com/playlist/679705bd169c31976bd92812/master.m3u8",
        ],
      },
    ],
  });
});

// ─── /info ───────────────────────────────────────────────────────────────────
app.get("/info", async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) return res.status(400).json({ error: "Missing ?url= param" });

  const page = parseInt(req.query.page || "1", 10);

  try {
    // ── Derive show slug from whatever URL was passed ─────────────────────────
    const showSlug = extractShowSlug(inputUrl);
    if (!showSlug) return res.status(400).json({ error: "Could not extract show slug from URL" });

    const pageUrl  = `https://kaa.lt/${showSlug}`;
    const lang     = req.query.lang || "ja-JP";

    // ── Fetch the show page to get episode info from window.KAA ──────────────
    const { data: html } = await axios.get(pageUrl, {
      headers: { ...HEADERS, Referer: "https://kaa.lt/" },
      maxRedirects: 10,
    });

    const $ = cheerio.load(html);
    let kaaRaw = "";
    $("script:not([src])").each((_, el) => {
      const content = $(el).html() || "";
      if (content.includes("window.KAA")) kaaRaw = content;
    });
    const decoded = he.decode(decodeUnicode(kaaRaw));

    // ── Helper extractors ─────────────────────────────────────────────────────
    const getField = (key, src) => {
      const m = src.match(new RegExp(`${key}:"([^"]*?)"`));
      return m ? m[1] : null;
    };
    const getNum = (key, src) => {
      const m = src.match(new RegExp(`${key}:(\\d+)`));
      return m ? parseInt(m[1], 10) : null;
    };

    // ── Current episode info (only if episode URL was passed) ─────────────────
    const isEpisodeUrl = /\/ep-/.test(inputUrl);
    let currentEp    = null;
    let episodeTitle = null;
    let nextSlug     = null;
    let prevSlug     = null;
    let servers      = [];

    if (isEpisodeUrl) {
      currentEp    = getNum("episode_number", decoded);
      episodeTitle = getField("episode_title", decoded);
      nextSlug     = getField("next_ep_slug", decoded);
      prevSlug     = getField("prev_ep_slug", decoded);

      // Extract servers
      const serversSection = decoded.match(/servers:\[([\s\S]*?)\]/);
      if (serversSection) {
        for (const m of serversSection[1].matchAll(
          /\{name:"([^"]+)",shortName:"([^"]+)",src:"([^"]+)"\}/g
        )) {
          servers.push({ name: m[1], shortName: m[2], src: m[3] });
        }
      }
    }

    // ── Sub/Dub: extract language from window.KAA ─────────────────────────────
    // kaa.lt uses language code like "ja-JP" to switch between sub/dub
    // The dropdown options come from the episodes API response
    let subDubOptions = [];
    const langInPage = getField("language", decoded) || lang;

    // ── Fetch episodes from API with page ─────────────────────────────────────
    let episodes   = [];
    let pageRanges = [];
    let totalEps   = 0;

    try {
      const epApiUrl = `https://kaa.lt/api/show/${showSlug}/episodes?lang=${langInPage}&page=${page}`;
      const { data: epData } = await axios.get(epApiUrl, {
        headers: { ...HEADERS, Referer: pageUrl },
      });

      episodes = Array.isArray(epData)
        ? epData
        : (epData.result || epData.episodes || epData.items || []);

      totalEps = epData.count || epData.total || epData.totalCount || null;
    } catch (_) {}

    // ── Fetch show metadata for Sub/Dub options ───────────────────────────────
    try {
      const showApiUrl = `https://kaa.lt/api/show/${showSlug}`;
      const { data: showData } = await axios.get(showApiUrl, {
        headers: { ...HEADERS, Referer: pageUrl },
      });

      const langs =
        showData.languages   ||
        showData.streams     ||
        showData.dubOptions  ||
        showData.audio       ||
        showData.lang        ||
        [];

      if (Array.isArray(langs) && langs.length > 0) {
        subDubOptions = langs.map(l => ({
          value: l.code  || l.value || l.language || l,
          label: l.label || l.name  || l.title    || l,
        }));
      }
    } catch (_) {}

    // ── Fallback Sub/Dub from window.KAA language field ──────────────────────
    if (subDubOptions.length === 0) {
      const labelMap = {
        "ja-JP": "Japanese (SUB)",
        "en-US": "English (DUB)",
        "zh-CN": "Chinese (SUB)",
        "ko-KR": "Korean (SUB)",
      };
      subDubOptions = [{
        value: langInPage,
        label: labelMap[langInPage] || langInPage,
      }];
    }

    // ── Build page ranges ─────────────────────────────────────────────────────
    if (totalEps) {
      for (let i = 0; i < totalEps; i += 100) {
        const from = i + 1;
        const to   = Math.min(i + 100, totalEps);
        pageRanges.push({
          value: Math.floor(i / 100) + 1,
          label: `${String(from).padStart(2, "0")}-${String(to).padStart(2, "0")}`,
        });
      }
    }

    res.json({
      showSlug,
      language:     langInPage,
      currentEp,
      episodeTitle,
      nextSlug,
      prevSlug,
      servers,
      subDub:       subDubOptions,
      page,
      totalEps,
      pageRanges,
      episodes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /scrape ─────────────────────────────────────────────────────────────────
app.get("/scrape", async (req, res) => {
  const pageUrl =
    req.query.url ||
    "https://kaa.lt/dark-moon-the-blood-altar-animation-with-enhypen-bd51/ep-12-4e6fdb";

  try {
    const { data: html } = await axios.get(pageUrl, {
      headers: { ...HEADERS, Referer: "https://kaa.lt/" },
      maxRedirects: 10,
    });

    const $ = cheerio.load(html);
    let kaaRaw = "";
    $("script:not([src])").each((_, el) => {
      const content = $(el).html() || "";
      if (content.includes("window.KAA")) kaaRaw = content;
    });
    const kaaDecoded = he.decode(decodeUnicode(kaaRaw));

    const srcMatches = [
      ...[...kaaDecoded.matchAll(/"src"\s*:\s*"(https?:\/\/[^"]+)"/g)].map(m => m[1]),
      ...[...kaaDecoded.matchAll(/'src'\s*:\s*'(https?:\/\/[^']+)'/g)].map(m => m[1]),
      ...[...kaaDecoded.matchAll(/"url"\s*:\s*"(https?:\/\/[^"]+)"/g)].map(m => m[1]),
      ...[...kaaDecoded.matchAll(/"file"\s*:\s*"(https?:\/\/[^"]+)"/g)].map(m => m[1]),
      ...[...kaaDecoded.matchAll(/(https?:\/\/[^\s"'\\>]*krussdomi[^\s"'\\>]*)/g)].map(m => m[1]),
    ];
    const uniqueSrcs = [...new Set(srcMatches)];

    const results = [];

    for (const playerUrl of uniqueSrcs) {
      try {
        const { data: playerHtml } = await axios.get(playerUrl, {
          headers: { ...HEADERS, Referer: pageUrl },
          maxRedirects: 10,
        });

        const decoded = he.decode(decodeUnicode(playerHtml));

        let m3u8Raw = [
          ...new Set([
            ...(decoded.match(/https?:\/\/[^\s"'\\>]+\.m3u8[^\s"'\\>]*/g) || []),
            ...(decoded.match(/\/\/[a-zA-Z0-9][^\s"'\\>]+\.m3u8[^\s"'\\>]*/g) || []),
          ])
        ];
        let m3u8Hits = [...new Set(m3u8Raw.map(fixUrl).filter(isAbsoluteUrl))];

        const astroProps = extractAstroProps(playerHtml);
        for (const props of astroProps) {
          const fromProps = collectStrings(props, /\.m3u8/).map(fixUrl).filter(isAbsoluteUrl);
          m3u8Hits = [...new Set([...m3u8Hits, ...fromProps])];
        }

        const catIdMatch = playerUrl.match(/[?&]id=([A-Za-z0-9+/=]+).*source=catstream/);
        if (catIdMatch && m3u8Hits.length === 0) {
          try {
            const decoded64 = Buffer.from(catIdMatch[1], "base64").toString("utf8");
            const videoId = decoded64.split(":")[0];
            if (videoId && /^[a-f0-9]{24}$/.test(videoId)) {
              m3u8Hits.push(`https://bl.krussdomi.com/playlist/${videoId}/master.m3u8`);
            }
          } catch (_) {}
        }

        const debug = [];
        let allAudio = [];
        let allVideo = [];
        for (const masterUrl of m3u8Hits) {
          const { audio, video } = await fetchMasterPlaylist(masterUrl, pageUrl, debug);
          allAudio.push(...audio);
          allVideo.push(...video);
        }

        const vttRaw = [...new Set(decoded.match(/https?:\/\/[^\s"'\\>]+\.vtt[^\s"'\\>]*/g) || [])];
        const srtRaw = [...new Set(decoded.match(/https?:\/\/[^\s"'\\>]+\.srt[^\s"'\\>]*/g) || [])];
        const allVttRaw = [...vttRaw];
        const allSrtRaw = [...srtRaw];
        for (const props of astroProps) {
          allVttRaw.push(...collectStrings(props, /\.vtt$/));
          allSrtRaw.push(...collectStrings(props, /\.srt$/));
        }
        const subtitles = {
          vtt: [...new Set(allVttRaw.map(fixUrl).filter(isAbsoluteUrl))],
          srt: [...new Set(allSrtRaw.map(fixUrl).filter(isAbsoluteUrl))],
        };

        const sourceMatch = playerUrl.match(/source=([^&]+)/);
        const source = sourceMatch ? sourceMatch[1] : "unknown";

        results.push({
          source,
          playerUrl,
          m3u8: m3u8Hits,
          audio: allAudio,
          video: allVideo,
          subtitles,
        });
      } catch (_) {}
    }

    res.json({
      m3u8:    results.flatMap(r => r.m3u8),
      audio:   results.flatMap(r => r.audio),
      video:   results.flatMap(r => r.video),
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /playlist ────────────────────────────────────────────────────────────────
app.get("/playlist", async (req, res) => {
  const m3u8Url = req.query.url || "https://bl.krussdomi.com/playlist/69c6bcd2ab00ea3267443866/master.m3u8";
  try {
    const response = await axios.get(m3u8Url, {
      headers: {
        ...HEADERS,
        Referer: "https://kaa.lt/",
        Origin: "https://kaa.lt",
        "x-origin": "KAA-Cat-Stream",
      },
      responseType: "text",
    });
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /proxy ───────────────────────────────────────────────────────────────────
app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Missing ?url= param" });
  try {
    const response = await axios.get(target, {
      headers: {
        ...HEADERS,
        Referer: "https://kaa.lt/",
        "x-origin": "KAA-Cat-Stream",
      },
      responseType: "stream",
    });
    res.setHeader("Content-Type", response.headers["content-type"] || "application/octet-stream");
    res.setHeader("Access-Control-Allow-Origin", "*");
    response.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /vtt ─────────────────────────────────────────────────────────────────────
app.get("/vtt", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Missing ?url= param" });
  try {
    const response = await axios.get(target, {
      headers: {
        ...HEADERS,
        Referer: "https://kaa.lt/",
        Origin: "https://kaa.lt",
        "x-origin": "KAA-Cat-Stream",
      },
      responseType: "arraybuffer",
    });
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", response.data.byteLength);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(response.data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /debug-master ────────────────────────────────────────────────────────────
app.get("/debug-master", async (req, res) => {
  const m3u8Url = req.query.url;
  if (!m3u8Url) return res.status(400).json({ error: "Missing ?url= param" });
  try {
    const response = await axios.get(m3u8Url, {
      headers: {
        ...HEADERS,
        Referer: "https://kaa.lt/",
        Origin: "https://kaa.lt",
        "x-origin": "KAA-Cat-Stream",
      },
      responseType: "text",
    });
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server → http://localhost:${PORT}`));