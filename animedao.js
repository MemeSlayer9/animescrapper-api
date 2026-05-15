const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
app.use(cors());

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Origin": "https://vibeplayer.site",
  "Referer": "https://vibeplayer.site/",
};

const PAGE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://google.com",
};

// In-memory cache: watchSlug → real animedao watchUrl
const watchUrlCache = new Map();

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getSlugCandidates(watchSlug) {
  const candidates = [watchSlug];

  const slugMatch = watchSlug.match(/^(.+)-episode-(\d+)$/);
  if (!slugMatch) return candidates;

  const animeSlug = slugMatch[1];
  const epNum     = slugMatch[2];

  // Strip trailing -NNN from anime slug: "one-piece-100" → "one-piece"
  const stripped = animeSlug.replace(/-\d+$/, "");
  if (stripped !== animeSlug) {
    candidates.push(`${stripped}-episode-${epNum}`);
  }

  return candidates; // ["one-piece-100-episode-1", "one-piece-episode-1"]
}

function toAbsolute(url, baseDir) {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return new URL(baseDir).origin + url;
  return baseDir + url;
}

function rewriteM3u8(content, originalUrl, proxyBase) {
  const base    = new URL(originalUrl);
  const baseDir = base.origin + base.pathname.replace(/\/[^/]*$/, "/");

  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const absolute = toAbsolute(uri, baseDir);
          return `URI="${proxyBase}/proxy/segment?url=${encodeURIComponent(absolute)}"`;
        });
      }

      const absolute = toAbsolute(trimmed, baseDir);

      if (/\.m3u8(\?|$)/.test(absolute)) {
        return `${proxyBase}/proxy/m3u8?url=${encodeURIComponent(absolute)}`;
      }
      return `${proxyBase}/proxy/segment?url=${encodeURIComponent(absolute)}`;
    })
    .join("\n");
}
function resolveM3u8(hash) {
  // Standard 16-char hex → vibeplayer CDN
  if (/^[a-f0-9]{16}$/.test(hash)) {
    return `https://vibeplayer.site/public/stream/${hash}/master.m3u8`;
  }
  // ag...h format → takutakucdn CDN
  if (/^ag[a-zA-Z0-9]+h$/.test(hash)) {
    return `https://file.takutakucdn.store/${hash}/master.m3u8`;
  }
  return null;
}
// Parse HSUB / SUB / DUB groups from HTML → only vibeplayer 16-char hex hashes
function extractByCategory(rawHtml) {
  const $          = cheerio.load(rawHtml);
  const categories = {};

  $("ul.server-items").each((_, ul) => {
    const labelRaw = $(ul).find("li:first-child strong").text().trim();
    const label    = labelRaw.replace(/[^a-zA-Z]/g, "").toLowerCase();
    if (!label) return;

    const servers = [];

    $(ul).find("li.server a[data-video]").each((_, a) => {
      const dataVideo  = $(a).attr("data-video") || "";
      const serverName = $(a).text().trim();

      // Match BOTH hash formats + optional ?sub= param
      const vibeMatch = dataVideo.match(
        /vibeplayer\.site\/((?:[a-f0-9]{16})|(?:ag[a-zA-Z0-9]+h))(?:\?sub=([^\s"'<>&]+))?/
      );
      if (!vibeMatch) return;

      const hash   = vibeMatch[1];
      const subUrl = vibeMatch[2] || null;
      const m3u8   = resolveM3u8(hash);
      if (!m3u8) return;

      servers.push({
        server:   serverName,
        hash,
        embed:    `https://vibeplayer.site/${hash}`,
        m3u8,
        subtitle: subUrl,
      });
    });

    if (servers.length) categories[label] = servers;
  });

  return categories;
}


// Fetch master.m3u8 → extract all quality variants
async function getAllQualities(masterUrl) {
  try {
    const response  = await axios.get(masterUrl, { headers: HEADERS });
    const lines     = response.data.split("\n");
    const baseDir   = masterUrl.replace(/\/[^/]*$/, "/");
    const qualities = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith("#EXT-X-STREAM-INF")) continue;

      const nextLine = (lines[i + 1] || "").trim();
      if (!nextLine || nextLine.startsWith("#")) continue;

      const resMatch  = line.match(/RESOLUTION=(\d+x\d+)/);
      const bwMatch   = line.match(/BANDWIDTH=(\d+)/);
      const nameMatch = line.match(/NAME="?([^",]+)"?/);

      const resolution = resMatch  ? resMatch[1]          : null;
      const bandwidth  = bwMatch   ? parseInt(bwMatch[1]) : 0;
      const height     = resolution ? parseInt(resolution.split("x")[1]) : 0;
      const label      = nameMatch  ? nameMatch[1] : height ? `${height}p` : `${bandwidth}bps`;

      qualities.push({
        label,
        resolution,
        bandwidth,
        height,
        original: toAbsolute(nextLine, baseDir),
      });
      i++;
    }

    return qualities.sort((a, b) => b.height - a.height);
  } catch (err) {
    console.error(`getAllQualities failed [${masterUrl}]:`, err.message);
    return [];
  }
}

// Build full stream entry for one server
async function buildStreamEntry(s, proxyBase) {
  const qualities   = await getAllQualities(s.m3u8);
  const proxiedM3u8 = `${proxyBase}/proxy/m3u8?url=${encodeURIComponent(s.m3u8)}`;
  const playerBase  = `${proxyBase}/player?url=${proxiedM3u8}`;
  const player      = s.subtitle ? `${playerBase}&sub=${encodeURIComponent(s.subtitle)}` : playerBase;

  return {
    server:      s.server,
    hash:        s.hash,
    player,
    proxiedM3u8,
    original:    s.m3u8,
    subtitle:    s.subtitle,
    qualities:   qualities.map((q) => {
      const proxied  = `${proxyBase}/proxy/m3u8?url=${encodeURIComponent(q.original)}`;
      const pBase    = `${proxyBase}/player?url=${proxied}`;
      const pPlayer  = s.subtitle ? `${pBase}&sub=${encodeURIComponent(s.subtitle)}` : pBase;
      return {
        label:      q.label,
        resolution: q.resolution,
        bandwidth:  q.bandwidth,
        original:   q.original,
        proxied,
        player:     pPlayer,
      };
    }),
  };
}


// ── ROUTES ────────────────────────────────────────────────────────────────────

// GET /episodes?url=https://animedao.ac/anime/one-piece
// GET /episodes/one-piece


app.get("/recent", async (req, res) => {
  const url = "https://animedao.ac/";

  let rawHtml;
  try {
    const response = await axios.get(url, { headers: PAGE_HEADERS, maxRedirects: 5 });
    rawHtml = response.data;
  } catch (err) {
    return res.status(500).json({ error: "Page fetch failed: " + err.message });
  }

  const $      = cheerio.load(rawHtml);
  const recent = [];

  $(".well").each((_, el) => {
    // Watch URL + watchSlug
    const watchPath = $(el).find("a[href*='/watch-online/']").first().attr("href") || null;
    const watchUrl  = watchPath ? `https://animedao.ac${watchPath}` : null;
    const watchSlug = watchPath ? watchPath.split("/watch-online/")[1] : null;

    // Anime page
    const animePath = $(el).find("a.latest-parent").attr("href") || null;
    const animeUrl  = animePath ? `https://animedao.ac${animePath}` : null;
    const animeSlug = animePath ? animePath.split("/anime/")[1] : null;

    // Title + episode number
    const rawTitle  = $(el).find(".latestanime-title a").text().trim();
    const titleMatch = rawTitle.match(/^(.+?)\s*\(\s*Episode\s*(\d+)\s*\)$/i);
    const animeTitle = titleMatch ? titleMatch[1].trim() : rawTitle;
    const epNum      = titleMatch ? parseInt(titleMatch[2]) : null;

    // Thumbnail
    const thumbnail = $(el).find("img").attr("src") || null;

    // Date
    const date = $(el).find(".front_time").text().trim().replace(/\s+/g, " ");

    // Stream URL (local proxy)
    const streamUrl = watchSlug
      ? `http://localhost:3000/source/${watchSlug}`
      : null;

    if (watchSlug) watchUrlCache.set(watchSlug, watchUrl);

    if (watchSlug) {
      recent.push({
        episodeId:         watchSlug,
        animeTitle,
        episode:    epNum,
        thumbnail,
        date,
        watchUrl,
        animeUrl,
        animeSlug,
        streamUrl,
      });
    }
  });

  res.json({ total: recent.length, recent });
});

app.get("/episodes/:animeSlug", async (req, res) => {
  const { animeSlug } = req.params;
  const url = `https://animedao.ac/anime/${animeSlug}`;

  let rawHtml;
  try {
    const response = await axios.get(url, { headers: PAGE_HEADERS, maxRedirects: 5 });
    rawHtml = response.data;
  } catch (err) {
    return res.status(500).json({ error: "Page fetch failed: " + err.message });
  }

  const $        = cheerio.load(rawHtml);
  const episodes = [];

  $(".episode_well").each((_, el) => {
    const titleRaw = $(el).find(".anime-title").text().trim();
    const dateRaw  = $(el).find(".front_time").text().trim();
    const date     = dateRaw.replace(/\s+/g, " ").trim();

    const link     = $(el).closest("a").attr("href") || $(el).find("a").attr("href") || null;
    const watchUrl = link
      ? (link.startsWith("http") ? link : `https://animedao.ac${link}`)
      : null;

    const watchSlug = watchUrl ? watchUrl.split("/watch-online/")[1] : null;
    const slugMatch = watchSlug ? watchSlug.match(/^(.+)-episode-(\d+)$/) : null;
    const epNum     = slugMatch ? parseInt(slugMatch[2]) : null;

    const id        = watchSlug || null;
    const episodeId = watchSlug || null;

    const colonIdx  = titleRaw.indexOf(":");
    const epTitle   = colonIdx !== -1 ? titleRaw.slice(colonIdx + 1).trim() : titleRaw;

    const streamUrl = watchSlug
      ? `http://localhost:3000/source/${watchSlug}`
      : null;

    if (watchSlug && watchUrl) watchUrlCache.set(watchSlug, watchUrl);

    if (titleRaw) {
      episodes.push({
        id,
        episodeId,
        episode:   epNum,
        title:     epTitle,
        fullTitle: titleRaw,
        date,
        watchUrl,
        streamUrl,
      });
    }
  });

  episodes.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  res.json({ total: episodes.length, episodes });
});

// GET /source/:watchSlug
// e.g. /source/one-piece-episode-2
//      /source/one-piece-100-episode-1
app.get("/source/:watchSlug", async (req, res) => {
  const { watchSlug } = req.params;

  const candidates = [
    watchUrlCache.get(watchSlug),   // cached exact URL first
    ...getSlugCandidates(watchSlug).map(s => `https://animedao.ac/watch-online/${s}`),
  ].filter(Boolean);

  // Deduplicate
  const uniqueCandidates = [...new Set(candidates)];

  const slugMatch = watchSlug.match(/^(.+)-episode-(\d+)$/);
  const animeSlug = slugMatch ? slugMatch[1] : watchSlug;
  const epNum     = slugMatch ? parseInt(slugMatch[2]) : null;

  let rawHtml    = null;
  let usedUrl    = null;

  // Try each candidate URL until one returns a valid page with streams
  for (const watchUrl of uniqueCandidates) {
    console.log(`[source] trying → ${watchUrl}`);
    try {
      const response = await axios.get(watchUrl, { headers: PAGE_HEADERS, maxRedirects: 5 });
      const html     = response.data;

      // Check it's not a 404 page
      if (html.includes("404") && html.includes("Pages not found")) {
        console.log(`[source] 404 → skipping`);
        continue;
      }

      // Check it has actual stream data
      const $ = cheerio.load(html);
      if ($("ul.server-items").length > 0 || $("[data-video]").length > 0) {
        rawHtml = html;
        usedUrl = watchUrl;
        console.log(`[source] ✓ found streams at ${watchUrl}`);
        break;
      }
    } catch (err) {
      console.log(`[source] error fetching ${watchUrl}: ${err.message}`);
    }
  }

  if (!rawHtml) {
    return res.status(404).json({
      error:      "No streams found — all slug candidates returned 404 or empty",
      tried:      uniqueCandidates,
    });
  }

  const categories = extractByCategory(rawHtml);
  if (!Object.keys(categories).length) {
    const $           = cheerio.load(rawHtml);
    const allDataVideos = [];
    $("[data-video]").each((_, el) => allDataVideos.push($(el).attr("data-video")));
    return res.status(404).json({
      error:      "Page found but no vibeplayer streams",
      usedUrl,
      dataVideos: allDataVideos,
    });
  }

  const proxyBase = `${req.protocol}://${req.get("host")}`;

  const result = {
    id:        watchSlug,
    episodeId: epNum != null ? `episode-${epNum}` : null,
    episode:   epNum,
    animeSlug,
    watchUrl:  usedUrl,   // the URL that actually worked
  };

  await Promise.all(
    Object.entries(categories).map(async ([cat, servers]) => {
      result[cat] = await Promise.all(servers.map((s) => buildStreamEntry(s, proxyBase)));
    })
  );

  res.json(result);
});


// Proxy + rewrite m3u8 playlists (master and media)
app.get("/proxy/m3u8", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing ?url=");

  const proxyBase = `${req.protocol}://${req.get("host")}`;

  try {
    const response  = await axios.get(url, { headers: HEADERS, responseType: "text" });
    const rewritten = rewriteM3u8(response.data, url, proxyBase);

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(rewritten);
  } catch (err) {
    console.error("m3u8 proxy error:", err.message);
    res.status(502).send("Failed to fetch m3u8: " + err.message);
  }
});

// Proxy media segments (.ts, keys, init segments)
app.get("/proxy/segment", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing ?url=");

  try {
    const response = await axios.get(url, { headers: HEADERS, responseType: "stream" });
    res.setHeader("Content-Type", response.headers["content-type"] || "video/MP2T");
    res.setHeader("Cache-Control", "max-age=3600");
    response.data.pipe(res);
  } catch (err) {
    console.error("Segment proxy error:", err.message);
    res.status(502).send("Failed to fetch segment: " + err.message);
  }
});

// Built-in HLS player — quality selector + optional subtitle track
app.get("/player", (req, res) => {
  const { url, sub } = req.query;
  if (!url) return res.status(400).send("Missing ?url=");

  const subTrack = sub
    ? `<track kind="subtitles" src="${sub}" srclang="en" label="English" default>`
    : "";

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Player</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; gap: 10px; }
    video { width: 100%; max-width: 1280px; max-height: 90vh; }
    #controls { display: flex; gap: 8px; align-items: center; }
    #qualitySelect {
      background: #222; color: #fff; border: 1px solid #555;
      padding: 6px 12px; border-radius: 4px; font-size: 14px; cursor: pointer;
    }
    #qualitySelect:hover { border-color: #fff; }
    #qualityLabel { color: #aaa; font-size: 13px; font-family: sans-serif; }
  </style>
</head>
<body>
  <video id="video" controls autoplay crossorigin="anonymous">
    ${subTrack}
  </video>
  <div id="controls">
    <span id="qualityLabel">Quality:</span>
    <select id="qualitySelect"><option value="-1">Auto</option></select>
  </div>
  <script>
    const src   = decodeURIComponent("${encodeURIComponent(url)}");
    const video = document.getElementById("video");
    const sel   = document.getElementById("qualitySelect");

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        video.play();
        data.levels.forEach((level, i) => {
          const opt  = document.createElement("option");
          opt.value  = i;
          opt.text   = level.height ? level.height + "p" : "Level " + i;
          sel.appendChild(opt);
        });
      });

      sel.addEventListener("change", () => {
        hls.currentLevel = parseInt(sel.value);
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, () => {
        if (hls.autoLevelEnabled) sel.value = -1;
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) console.error("HLS fatal error:", data.type, data.details);
      });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      video.play();
      document.getElementById("controls").style.display = "none";
    } else {
      document.body.innerHTML = '<p style="color:red;padding:20px;font-family:sans-serif">HLS not supported.</p>';
    }
  </script>
</body>
</html>`);
});

// ── START ─────────────────────────────────────────────────────────────────────
app.get("/debug", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Provide ?url=" });

  let rawHtml = "";
  try {
    const response = await axios.get(url, { headers: PAGE_HEADERS, maxRedirects: 5 });
    rawHtml = response.data;
  } catch (err) {
    return res.status(500).json({ error: "Fetch failed: " + err.message });
  }

  const $ = cheerio.load(rawHtml);

  // Grab every single script tag content
  const scripts = [];
  $("script").each((_, el) => {
    const content = $(el).html() || "";
    const src     = $(el).attr("src") || "";
    if (content.length > 10) scripts.push({ src, preview: content.substring(0, 500) });
    else if (src) scripts.push({ src, preview: "" });
  });

  // All anchor/data-video attributes anywhere on page
  const dataVideos = [];
  $("[data-video]").each((_, el) => dataVideos.push($(el).attr("data-video")));

  // All iframes
  const iframes = [];
  $("iframe").each((_, el) => iframes.push(el.attribs));

  // Look for vibeplayer anywhere in raw HTML
  const vibeRefs = (rawHtml.match(/vibeplayer\.site[^\s"'<>]*/g) || []);

  // Look for any API calls / fetch / ajax in scripts
  const apiCalls = (rawHtml.match(/fetch\(['"`][^'"`]+['"`]\)|ajax\(\{[^}]+\}\)|url:\s*['"`][^'"`]+['"`]/g) || []);

  // Check for csrf token (used for authenticated requests)
  const csrfToken = $('meta[name="csrf-token"]').attr("content") || null;

  // Raw HTML snippet — first 5000 chars
  const htmlSnippet = rawHtml.substring(0, 5000);

  res.json({
    csrfToken,
    serverItemsCount: $("ul.server-items").length,
    dataVideos,
    vibeRefs,
    iframes,
    apiCalls,
    scripts: scripts.slice(0, 10),
    htmlSnippet,
  });
});
app.listen(3000, () => {
  console.log("\nServer running → http://localhost:3000\n");
  console.log("── Endpoints ──────────────────────────────────────────────────────");
  console.log("List episodes:  GET /episodes?url=https://animedao.ac/anime/SLUG");
  console.log("Watch episode:  GET /source/:watchSlug");
  console.log("  e.g.          GET /source/one-piece-episode-2");
  console.log("  e.g.          GET /source/one-piece-100-episode-1");
  console.log("Proxy m3u8:     GET /proxy/m3u8?url=<m3u8-url>");
  console.log("Proxy segment:  GET /proxy/segment?url=<segment-url>");
  console.log("Player:         GET /player?url=<proxied-m3u8>&sub=<vtt-url>");
  console.log("───────────────────────────────────────────────────────────────────\n");
});