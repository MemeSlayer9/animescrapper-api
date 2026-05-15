import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const PAGE_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.6",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Referer": "https://animeya.cc/",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Upgrade-Insecure-Requests": "1",
};

const CDN_HEADERS = {
  "User-Agent": UA,
  Origin: "https://398fitus.com",
  Referer: "https://398fitus.com/",
};

function parseAllEpisodes(html) {
  const episodes = [];
  const chunks = html.split("self.__next_f.push");

  for (const chunk of chunks) {
    if (!chunk.includes("sharepoint.com")) continue;
    if (!chunk.includes("download.aspx")) continue;

    const idMatch = chunk.match(/"id\\?":\s*(\d{5,})/);
    if (!idMatch) continue;
    const episodeId = parseInt(idMatch[1]);

    const sources = { HARD: null, NONE: null, SOFT: null };

    const subTypeUrlRegex =
      /"subType\\?":\s*\\?"(HARD|NONE|SOFT)\\?"[^}]{0,400}?download\.aspx\?share=([A-Za-z0-9_\-]+)/g;

    let m;
    while ((m = subTypeUrlRegex.exec(chunk)) !== null) {
      const subType = m[1];
      const shareToken = m[2];
      if (!sources[subType]) {
        sources[subType] =
          `https://myanime.sharepoint.com/sites/chartlousty/_layouts/15/download.aspx?share=${shareToken}`;
      }
    }

    if (!sources.HARD && !sources.NONE && !sources.SOFT) continue;

    episodes.push({ episodeId, sources });
  }

  episodes.sort((a, b) => a.episodeId - b.episodeId);

  const seen = new Set();
  return episodes.filter((ep) => {
    if (seen.has(ep.episodeId)) return false;
    seen.add(ep.episodeId);
    return true;
  });
}

async function getVideoInfo(baseUrl, episodeNum) {
  console.log(`[scrape] GET ${baseUrl} → episode ${episodeNum}`);

  const { data: html } = await axios.get(baseUrl, {
    headers: PAGE_HEADERS,
    timeout: 20000,
  });

  const $ = cheerio.load(html);
  const ogTitle = $('meta[property="og:title"]').attr("content") || null;
  const ogImage = $('meta[property="og:image"]').attr("content") || null;
  const pageTitle = $("title").text().trim() || null;

  const episodes = parseAllEpisodes(html);
  console.log(`[scrape] parsed ${episodes.length} episodes`);

  if (episodes.length === 0) {
    const idx = html.indexOf("sharepoint.com");
    if (idx !== -1) {
      console.log("[debug] sharepoint context:", html.slice(Math.max(0, idx - 300), idx + 300));
    }
    return { ogTitle, ogImage, pageTitle, episodeNumber: episodeNum, sources: null };
  }

  const epIdx = Math.max(0, Math.min((episodeNum ?? 1) - 1, episodes.length - 1));
  const ep = episodes[epIdx];

  console.log(`[scrape] ep${episodeNum} → episodeId=${ep.episodeId} sources=`, ep.sources);

  return {
    ogTitle,
    ogImage,
    pageTitle,
    episodeNumber: episodeNum,
    totalEpisodes: episodes.length,
    episodeId: ep.episodeId,
    sources: ep.sources,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    message: 'Anime Scraper API',
    version: '1.2.0',
       episodes:  { base: '/episodes?url=https://animeya.cc/watch/jujutsu-kaisen-113415' },
      video:  { base: '/video-info?url=https://animeya.cc/watch/jujutsu-kaisen-113415' },
      
   });
});
// GET /episodes?url=https://animeya.cc/watch/jujutsu-kaisen-113415
// Returns all episodes with their episodeId, episodeNumber, and available subtypes
app.get("/episodes", async (req, res) => {
  try {
    const baseUrl = (req.query.url || "").split("?")[0];
    if (!baseUrl) return res.status(400).json({ error: "Missing url" });

    console.log(`[episodes] scraping ${baseUrl}`);

    const { data: html } = await axios.get(baseUrl, {
      headers: PAGE_HEADERS,
      timeout: 20000,
    });

    const $ = cheerio.load(html);
    const ogTitle = $('meta[property="og:title"]').attr("content") || null;
    const ogImage = $('meta[property="og:image"]').attr("content") || null;
    const pageTitle = $("title").text().trim() || null;

    const rawEpisodes = parseAllEpisodes(html);

    if (rawEpisodes.length === 0) {
      return res.status(404).json({ error: "No episodes found for this URL" });
    }

    const proxyBase = `${req.protocol}://${req.get("host")}`;
    const buildProxy = (url) =>
      url ? `${proxyBase}/stream?url=${encodeURIComponent(url)}` : null;

    const episodes = rawEpisodes.map((ep, index) => ({
      episodeNumber: index + 1,
      episodeId: ep.episodeId,
      subtypes: {
        HARD: ep.sources.HARD
          ? { videoUrl: ep.sources.HARD, proxyUrl: buildProxy(ep.sources.HARD), label: "Hard Sub" }
          : null,
        NONE: ep.sources.NONE
          ? { videoUrl: ep.sources.NONE, proxyUrl: buildProxy(ep.sources.NONE), label: "Dub" }
          : null,
        SOFT: ep.sources.SOFT
          ? { videoUrl: ep.sources.SOFT, proxyUrl: buildProxy(ep.sources.SOFT), label: "Soft Sub" }
          : null,
      },
    }));

    return res.json({
      animeTitle: ogTitle || pageTitle,
      ogImage,
      totalEpisodes: episodes.length,
      episodes,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch episodes", details: err.message });
  }
});

app.get("/scrape", async (req, res) => {
  try {
    const url = (req.query.url || "").split("?")[0];
    if (!url) return res.status(400).json({ error: "Missing url" });
    const episode = req.query.episode ? parseInt(req.query.episode) : 1;
    res.json(await getVideoInfo(url, episode));
  } catch (err) {
    res.status(500).json({ error: "Failed to scrape", details: err.message });
  }
});

app.get("/video-info", async (req, res) => {
  try {
    const baseUrl = (req.query.url || "").split("?")[0];
    if (!baseUrl) return res.status(400).json({ error: "Missing url" });

    const proxyBase = `${req.protocol}://${req.get("host")}`;
    const requestedEpisode = req.query.episode ? parseInt(req.query.episode) : 1;

    const { sources, ogTitle, ogImage, pageTitle, totalEpisodes, episodeId } =
      await getVideoInfo(baseUrl, requestedEpisode);

    if (!sources || (!sources.HARD && !sources.NONE && !sources.SOFT)) {
      return res.status(404).json({
        error: `Could not find video URL for episode ${requestedEpisode}`,
      });
    }

    const defaultUrl = sources.HARD || sources.NONE || sources.SOFT;
    const isHLS = defaultUrl.includes(".m3u8");

    const buildProxy = (url) =>
      url ? `${proxyBase}/stream?url=${encodeURIComponent(url)}` : null;

    const subtypes = {
      HARD: sources.HARD
        ? { videoUrl: sources.HARD, proxyUrl: buildProxy(sources.HARD), label: "Hard Sub" }
        : null,
      NONE: sources.NONE
        ? { videoUrl: sources.NONE, proxyUrl: buildProxy(sources.NONE), label: "Dub" }
        : null,
      SOFT: sources.SOFT
        ? { videoUrl: sources.SOFT, proxyUrl: buildProxy(sources.SOFT), label: "Soft Sub" }
        : null,
    };

    const base = {
      animeTitle: ogTitle || pageTitle,
      ogImage,
      episodeNumber: requestedEpisode,
      episodeId,
      totalEpisodes: totalEpisodes || null,
      videoUrl: defaultUrl,
      proxyUrl: buildProxy(defaultUrl),
      type: isHLS ? "hls" : "direct",
      subtypes,
    };

    if (isHLS) {
      return res.json({ ...base, filename: null, contentType: "application/vnd.apple.mpegurl" });
    }

    try {
      const headRes = await axios.head(defaultUrl, { headers: CDN_HEADERS });
      const headers = headRes.headers;
      const filenameMatch = (headers["content-disposition"] || "").match(/filename="(.+?)"/);
      return res.json({
        ...base,
        filename: filenameMatch ? filenameMatch[1] : null,
        contentType: headers["content-type"],
        contentLength: headers["content-length"],
        sizeMB: headers["content-length"]
          ? (parseInt(headers["content-length"]) / 1024 / 1024).toFixed(2)
          : null,
      });
    } catch {
      return res.json(base);
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to get video info", details: err.message });
  }
});

app.get("/stream", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing url" });

    const isM3U8 = url.includes(".m3u8");
    const range = req.headers.range;

    const response = await axios.get(url, {
      responseType: isM3U8 ? "text" : "stream",
      headers: { ...CDN_HEADERS, ...(range ? { Range: range } : {}) },
    });

    if (isM3U8) {
      const proxyBase = `${req.protocol}://${req.get("host")}`;
      const resolveUrl = (base, rel) => {
        try { return new URL(rel, base).toString(); } catch { return rel; }
      };
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      return res.send(
        response.data.split("\n").map((line) => {
          const t = line.trim();
          if (!t || t.startsWith("#")) return line;
          return `${proxyBase}/stream?url=${encodeURIComponent(resolveUrl(url, t))}`;
        }).join("\n")
      );
    }

    res.setHeader("Content-Type", response.headers["content-type"] || "video/mp2t");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    if (response.headers["content-length"])
      res.setHeader("Content-Length", response.headers["content-length"]);
    if (response.headers["content-range"])
      res.setHeader("Content-Range", response.headers["content-range"]);
    res.status(response.status);
    response.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: "Stream failed", details: err.message });
  }
});

app.listen(3000, () => console.log("Server running on port 3000"));