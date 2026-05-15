/**
 * index.js  —  Single file, no Playwright, no Puppeteer
 * 
 * npm install axios cheerio cors express
 * 
 * DEBUG (run once, shows exactly what the page returns):
 *   node index.js debug "https://animeepisodeseries.com/the-drops-of-god-episode-2-english-subbed/"
 * 
 * SERVER:
 *   node index.js
 *   GET http://localhost:3000/scrape?url=<anime-page-url>
 *   GET http://localhost:3000/proxy?url=<mp4-url>          (streams with correct Referer)
 */

const axios   = require("axios");
const cheerio = require("cheerio");
const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

// ─── Shared HTTP client ───────────────────────────────────────────────────────

function http(extra = {}) {
  return axios.create({
    timeout: 20000,
    maxRedirects: 15,
    headers: {
      "User-Agent"     : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control"  : "no-cache",
      ...extra,
    },
  });
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function abs(url, base) {
  if (!url) return null;
  url = url.trim();
  if (url.startsWith("http")) return url;
  if (url.startsWith("//"))   return "https:" + url;
  try { return new URL(url, base).href; } catch { return url; }
}

function uniqArr(arr) { return [...new Set(arr.filter(Boolean))]; }

// Pull every http(s) URL out of a string
function grabUrls(text) {
  return (text.match(/https?:\/\/[^\s"'`\\<>{}|\[\]^)]+/g) || [])
    .map(u => u.replace(/[.,;)'">`\]]+$/, ""));
}

// ─── Step A: Fetch the anime page ────────────────────────────────────────────

async function fetchAnimePage(pageUrl) {
  const { data: html, headers: resHeaders, request: req } =
    await http({ Accept: "text/html,application/xhtml+xml,*/*;q=0.9" }).get(pageUrl);

  const finalUrl = req?.res?.responseUrl || pageUrl;
  const $ = cheerio.load(html);

  // Every iframe on the page (including data-src / data-lazy-src)
  const iframes = [];
  $("iframe").each((_, el) => {
    ["src","data-src","data-lazy-src","data-url"].forEach(attr => {
      const v = $(el).attr(attr);
      if (v) iframes.push(abs(v, finalUrl));
    });
  });

  // All URLs found anywhere in inline scripts
  const scriptUrls = [];
  $("script:not([src])").each((_, el) => {
    grabUrls($(el).html() || "").forEach(u => scriptUrls.push(u));
  });

  // External script srcs
  const externalScripts = [];
  $("script[src]").each((_, el) => {
    const s = abs($(el).attr("src"), finalUrl);
    if (s) externalScripts.push(s);
  });

  // Meta og:video
  const ogVideo = $('meta[property="og:video"], meta[property="og:video:url"]').attr("content");

  // Raw HTML patterns that JS might inject later
  // (some sites put the iframe URL in a data attribute on a div)
  const dataAttrs = [];
  $("[data-src],[data-video],[data-embed],[data-file],[data-url]").each((_, el) => {
    ["data-src","data-video","data-embed","data-file","data-url"].forEach(a => {
      const v = $(el).attr(a);
      if (v && v.startsWith("http")) dataAttrs.push(v);
    });
  });

  return { html, finalUrl, iframes, scriptUrls, externalScripts, ogVideo, dataAttrs };
}

// ─── Step B: Fetch one embed/iframe page, extract video URL ──────────────────

async function extractFromPage(url, referer) {
  const { data: html } =
    await http({ Accept: "text/html,*/*", Referer: referer }).get(url);

  const $ = cheerio.load(html);
  const result = { url, iframes: [], mp4: [], m3u8: [], shared4: [], jwSources: [] };

  // Child iframes
  $("iframe").each((_, el) => {
    const s = abs($(el).attr("src") || $(el).attr("data-src"), url);
    if (s) result.iframes.push(s);
  });

  // All inline script URLs
  $("script:not([src])").each((_, el) => {
    const code = $(el).html() || "";
    grabUrls(code).forEach(u => {
      if (u.includes(".mp4"))         result.mp4.push(u);
      else if (u.includes(".m3u8"))   result.m3u8.push(u);
      else if (u.includes("4shared")) result.shared4.push(u);
    });

    // JWPlayer / VideoJS sources array
    const jwMatch = code.match(/sources\s*:\s*\[([^\]]+)\]/s);
    if (jwMatch) {
      grabUrls(jwMatch[1]).forEach(u => result.jwSources.push(u));
    }
    // file: "url"  pattern
    const fileMatch = code.match(/(?:file|src)\s*:\s*["'`](https?[^"'`]+)["'`]/g) || [];
    fileMatch.forEach(m => {
      const u = m.match(/["'`](https?[^"'`]+)["'`]/)?.[1];
      if (u) result.jwSources.push(u);
    });
  });

  // og:video
  const ogVideo = $('meta[property="og:video"], meta[property="og:video:url"]').attr("content");
  if (ogVideo) result.mp4.push(ogVideo);

  // <video src>
  $("video[src], source[src]").each((_, el) => {
    const s = $(el).attr("src");
    if (s?.includes(".mp4")) result.mp4.push(s);
  });

  // Deduplicate
  Object.keys(result).forEach(k => Array.isArray(result[k]) && (result[k] = uniqArr(result[k])));

  return { result, html };
}

// ─── Step C: 4shared playlist API (returns signed mp4 URL) ──────────────────

async function get4sharedApi(fileId, referer) {
  const endpoints = [
    `https://www.4shared.com/web/playlist/video/${fileId}`,
    `https://www.4shared.com/web/preview/video/${fileId}`,
  ];
  const client = http({
    Accept          : "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    Referer         : referer || `https://www.4shared.com/video/${fileId}/_online.html`,
  });

  for (const url of endpoints) {
    try {
      const { data } = await client.get(url);
      const text = typeof data === "string" ? data : JSON.stringify(data);

      // Try known JSON shapes
      if (typeof data === "object") {
        const sources =
          data?.playlist?.[0]?.sources ||
          data?.sources ||
          data?.playlist ||
          [];
        const mp4 = (Array.isArray(sources) ? sources : [])
          .find(s => (s.type||"").includes("mp4") || (s.file||"").includes(".mp4"));
        if (mp4?.file) return { endpoint: url, videoUrl: mp4.file };
        if (data?.file)        return { endpoint: url, videoUrl: data.file };
        if (data?.url)         return { endpoint: url, videoUrl: data.url };
        if (data?.downloadUrl) return { endpoint: url, videoUrl: data.downloadUrl };
      }

      // Fallback regex
      const mp4 = text.match(/https?:\/\/dc\d+\.4shared\.com\/[^\s"'\\]+\.mp4/);
      if (mp4) return { endpoint: url, videoUrl: mp4[0] };
    } catch (_) {}
  }
  return null;
}

// ─── Step D: Extract 4shared file ID from any URL or text ───────────────────

function extract4sharedFileId(text) {
  const ids = new Set();
  const pats = [
    /4shared\.com\/(?:video|embed|get|web\/(?:preview|playlist)\/video)\/([A-Za-z0-9_-]{6,})/g,
    /(?:fileId|file_id|videoId|vid)\s*[=:]\s*["']([A-Za-z0-9_-]{6,})["']/g,
    /\/([A-Za-z0-9_-]{8,10})\/(?:_online|online)\.html/g,
  ];
  for (const p of pats) {
    let m; while ((m = p.exec(text)) !== null) ids.add(m[1]);
  }
  return [...ids];
}

// ─── Master pipeline ─────────────────────────────────────────────────────────

async function scrape(pageUrl) {
  const log = [];
  const L = (obj) => log.push(obj);

  // ── 1. Fetch anime page ──
  L({ step: 1, action: "fetch_anime_page", url: pageUrl });
  let page;
  try {
    page = await fetchAnimePage(pageUrl);
  } catch (e) {
    return { error: `Step 1 failed: ${e.message}`, log };
  }
  L({
    step: 1,
    ok: true,
    htmlLength    : page.html.length,
    iframes       : page.iframes,
    dataAttrs     : page.dataAttrs,
    ogVideo       : page.ogVideo,
    scriptUrlCount: page.scriptUrls.length,
    scriptUrlSample: page.scriptUrls.slice(0, 20),
  });

  // Quick win: mp4/m3u8 directly in page scripts
  const directMp4 = page.scriptUrls.find(u => u.includes(".mp4"));
  if (directMp4) return { videoUrl: directMp4, source: "page_script", log };
  const directM3u8 = page.scriptUrls.find(u => u.includes(".m3u8"));
  if (directM3u8) return { videoUrl: directM3u8, source: "page_script_m3u8", log };
  if (page.ogVideo) return { videoUrl: page.ogVideo, source: "og_video", log };

  // ── 2. Collect all embed/iframe candidates ──
  const allText = page.html + page.scriptUrls.join(" ") + page.dataAttrs.join(" ");

  // 4shared file IDs found anywhere on the page
  const fileIds = extract4sharedFileId(allText);
  L({ step: 2, fileIds });

  // iframe queue: real <iframe> srcs + any 4shared embed URL we found
  const iframeQueue = uniqArr([
    ...page.iframes,
    ...page.dataAttrs.filter(u => u.includes("4shared")),
    ...page.scriptUrls.filter(u => u.includes("4shared.com") || u.includes("embed") || u.includes("player")),
    ...fileIds.map(id => `https://www.4shared.com/video/${id}/_online.html`),
  ]);
  L({ step: 2, iframeQueue });

  // ── 3. Walk iframe chain (2 levels) ──
  let allMp4    = [];
  let allM3u8   = [];
  let allShared = [];
  let childIframes = [];

  for (const iUrl of iframeQueue) {
    L({ step: 3, action: "fetch_iframe", url: iUrl });
    try {
      const { result, html: iHtml } = await extractFromPage(iUrl, pageUrl);
      L({ step: 3, url: iUrl, found: result });

      allMp4.push(...result.mp4, ...result.jwSources.filter(u => u.includes(".mp4")));
      allM3u8.push(...result.m3u8);
      allShared.push(...result.shared4);
      childIframes.push(...result.iframes);

      // Also extract file IDs from this page
      const ids2 = extract4sharedFileId(iHtml + result.shared4.join(" "));
      ids2.forEach(id => {
        if (!fileIds.includes(id)) fileIds.push(id);
        childIframes.push(`https://www.4shared.com/video/${id}/_online.html`);
      });

      if (allMp4.length) {
        return { videoUrl: uniqArr(allMp4)[0], source: "iframe_direct", log };
      }
    } catch (e) {
      L({ step: 3, url: iUrl, error: e.message });
    }
  }

  // ── 4. Walk level-2 iframes ──
  for (const iUrl of uniqArr(childIframes)) {
    L({ step: 4, action: "fetch_nested_iframe", url: iUrl });
    try {
      const { result } = await extractFromPage(iUrl, iframeQueue[0] || pageUrl);
      L({ step: 4, url: iUrl, found: result });
      allMp4.push(...result.mp4, ...result.jwSources.filter(u => u.includes(".mp4")));
      allM3u8.push(...result.m3u8);
      allShared.push(...result.shared4);
      if (allMp4.length) {
        return { videoUrl: uniqArr(allMp4)[0], source: "nested_iframe", log };
      }
    } catch (e) {
      L({ step: 4, url: iUrl, error: e.message });
    }
  }

  // ── 5. Call 4shared playlist API for each file ID ──
  for (const fileId of uniqArr(fileIds)) {
    L({ step: 5, action: "4shared_api", fileId });
    try {
      const api = await get4sharedApi(fileId, iframeQueue[0]);
      if (api) {
        L({ step: 5, fileId, endpoint: api.endpoint });
        return { videoUrl: api.videoUrl, fileId, source: "4shared_api", log };
      }
      L({ step: 5, fileId, found: false });
    } catch (e) {
      L({ step: 5, fileId, error: e.message });
    }
  }

  // ── 6. Return best m3u8 or shared4 we found ──
  allM3u8   = uniqArr(allM3u8);
  allShared = uniqArr(allShared);

  if (allM3u8.length)   return { videoUrl: allM3u8[0],   source: "m3u8",    log };
  if (allShared.length) return { videoUrl: allShared[0], source: "4shared_partial", log };

  return { error: "Could not find video URL", log };
}

// ─── DEBUG mode ──────────────────────────────────────────────────────────────

async function debug(pageUrl) {
  console.log("\n=== ANIME PAGE RAW FETCH ===\n");

  let html;
  try {
    const res = await http({ Accept: "text/html,*/*" }).get(pageUrl);
    html = res.data;
    const dumpPath = path.join(process.cwd(), "dump_page.html");
    fs.writeFileSync(dumpPath, html);
    console.log(`✓ Page fetched. Length: ${html.length}. Saved → ${dumpPath}`);
  } catch (e) {
    console.error("✗ Fetch failed:", e.message);
    return;
  }

  const $ = cheerio.load(html);

  console.log("\n─── IFRAMES ───");
  $("iframe").each((_, el) => {
    console.log("  src       :", $(el).attr("src"));
    console.log("  data-src  :", $(el).attr("data-src"));
    console.log("  data-url  :", $(el).attr("data-url"));
  });

  console.log("\n─── DATA ATTRIBUTES (video/embed/src/url) ───");
  $("[data-src],[data-video],[data-embed],[data-file],[data-url]").each((_, el) => {
    const tag = el.tagName;
    ["data-src","data-video","data-embed","data-file","data-url"].forEach(a => {
      const v = $(el).attr(a);
      if (v) console.log(`  <${tag}> ${a}: ${v}`);
    });
  });

  console.log("\n─── SCRIPTS containing 4shared / embed / player / mp4 / m3u8 ───");
  let si = 0;
  $("script:not([src])").each((_, el) => {
    const code = $(el).html() || "";
    if (/(4shared|embed|player|jwplayer|mp4|m3u8|videojs|source|file\s*:)/i.test(code)) {
      console.log(`\n  [script #${si++}] (first 1500 chars)`);
      console.log(code.substring(0, 1500));
      console.log("  ...");
    }
  });

  console.log("\n─── EXTERNAL SCRIPTS ───");
  $("script[src]").each((_, el) => console.log(" ", $(el).attr("src")));

  console.log("\n─── ALL URLs found in scripts ───");
  const allUrls = [];
  $("script:not([src])").each((_, el) => grabUrls($(el).html() || "").forEach(u => allUrls.push(u)));
  uniqArr(allUrls).forEach(u => console.log(" ", u));

  console.log("\n─── 4SHARED file IDs found ───");
  const ids = extract4sharedFileId(html);
  console.log(" ", ids.length ? ids : "NONE");

  console.log("\n─── META og:video ───");
  console.log(" ", $('meta[property="og:video"]').attr("content") || "NONE");

  console.log("\n=== NOW RUNNING FULL SCRAPE ===\n");
  const result = await scrape(pageUrl);
  console.log(JSON.stringify(result, null, 2));
}

// ─── Express server ──────────────────────────────────────────────────────────

const app = express();
app.use(cors());

app.get("/scrape", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url param required" });
  try {
    res.json(await scrape(url));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxies video with correct Referer so 4shared CDN allows it
app.get("/proxy", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const upstream = await axios.get(url, {
      responseType: "stream",
      headers: {
        "User-Agent"     : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer"        : "https://www.4shared.com/",
        "Accept"         : "*/*",
        "Accept-Encoding": "identity;q=1, *;q=0",
        "Range"          : req.headers.range || "bytes=0-",
      },
    });
    res.status(upstream.status);
    ["content-type","content-length","content-range","accept-ranges"]
      .forEach(h => upstream.headers[h] && res.setHeader(h, upstream.headers[h]));
    res.setHeader("Access-Control-Allow-Origin", "*");
    upstream.data.pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

// ─── Entry point ─────────────────────────────────────────────────────────────

const [,, mode, urlArg] = process.argv;

if (mode === "debug" && urlArg) {
  debug(urlArg).catch(console.error);
} else if (mode?.startsWith("http")) {
  // node index.js <url>  →  quick scrape
  scrape(mode).then(r => console.log(JSON.stringify(r, null, 2))).catch(console.error);
} else {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Scraper running → http://localhost:${PORT}`);
    console.log(`  GET /scrape?url=<anime-page>`);
    console.log(`  GET /proxy?url=<mp4-url>`);
  });
}