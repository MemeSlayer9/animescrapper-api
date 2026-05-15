import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import { gotScraping } from "got-scraping";
import axios from "axios";

const app  = express();
const PORT = 3000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─── Simple cookie store ──────────────────────────────────────────────────────
const cookieJar = new Map();

function mergeCookies(domain, setCookieHeaders = []) {
  const existing = cookieJar.get(domain) || "";
  const map = Object.fromEntries(
    existing.split(";").map((p) => p.trim().split("=")).filter((p) => p[0])
  );
  for (const raw of setCookieHeaders) {
    const [pair] = raw.split(";");
    const [k, v] = pair.split("=");
    if (k) map[k.trim()] = (v || "").trim();
  }
  const merged = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
  cookieJar.set(domain, merged);
  return merged;
}

function getCookies(domain) {
  return cookieJar.get(domain) || "";
}

function domainOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function browserHeaders(referer = "https://www.wcostream.tv/", extra = {}) {
  return {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-Gpc": "1",
    Connection: "keep-alive",
    Referer: referer,
    ...extra,
  };
}

async function scrapeGet(url, headers = {}, referer = "https://www.wcostream.tv/") {
  const domain = domainOf(url);
  const cookies = getCookies(domain) || getCookies("wcostream.tv") || getCookies("embed.wcostream.com");

  const response = await gotScraping({
    url,
    headers: {
      ...browserHeaders(referer),
      ...headers,
      ...(cookies ? { Cookie: cookies } : {}),
    },
    throwHttpErrors: false,
    followRedirect: true,
  });

  const setCookie = response.headers["set-cookie"] || [];
  if (setCookie.length) mergeCookies(domain, setCookie);

  return response;
}

// ─── evid extraction helpers ──────────────────────────────────────────────────

function extractGetvidlinkParams($) {
  let v = null, embed = null, hd = "1";

  $("script").each((_, el) => {
    if (v) return;
    const code = $(el).html() || "";
    const m = code.match(/getvidlink\.php\?([^"']+)/);
    if (m) {
      const qs = new URLSearchParams(m[1]);
      v     = qs.get("v")     || null;
      embed = qs.get("embed") || null;
      hd    = qs.get("hd")    || "1";
    }
  });

  return { v, embed, hd };
}

const EVID_PATTERNS = [
  /(?:https?:)?\/\/[a-z0-9]+\.wcostream\.com\/getvid\?evid=([A-Za-z0-9_\-]{20,})/,
  /evid\s*[=:]\s*["']([A-Za-z0-9_\-]{20,})["']/,
  /[?&]evid=([A-Za-z0-9_\-]{20,})/,
  /evid[=\s"':]+([A-Za-z0-9_\-]{20,})/,
];

function extractEvid($) {
  let evid = null;
  let cdnHost = null;

  const fullPattern = /(?:https?:)?\/\/([a-z0-9]+\.wcostream\.com)\/getvid\?evid=([A-Za-z0-9_\-]{20,})/g;
  const rawHtml = $.html();

  let m;
  while ((m = fullPattern.exec(rawHtml)) !== null) {
    cdnHost = m[1];
    evid    = m[2];
    break;
  }

  if (!evid) {
    $("script").each((_, el) => {
      if (evid) return;
      const code = $(el).html() || "";
      for (const pat of EVID_PATTERNS) {
        const match = code.match(pat);
        if (match) {
          evid = match[1];
          const hostMatch = code.match(/(?:https?:)?\/\/([a-z0-9]+\.wcostream\.com)\/getvid/);
          if (hostMatch) cdnHost = hostMatch[1];
          break;
        }
      }
    });
  }

  if (!evid) {
    for (const pat of EVID_PATTERNS) {
      const match = rawHtml.match(pat);
      if (match) {
        evid = match[1];
        break;
      }
    }
  }

  return { evid, cdnHost: cdnHost || "nd02.wcostream.com" };
}

// ─── Strip CDN URL wrappers (e.g. __https://...__ returned by some servers) ──
function cleanCdnUrl(raw) {
  if (!raw) return null;
  const s = typeof raw === "string" ? raw.trim() : null;
  if (!s) return null;
  // strip leading/trailing underscores, pipes, quotes
  return s.replace(/^[_|"']+|[_|"']+$/g, "").trim();
}

// ─── Build a getvid URL from server + evid ───────────────────────────────────
function getvid(server, evid) {
  if (!evid) return null;
  const base = server.startsWith("http") ? server : `https://${server}`;
  return `${base}/getvid?evid=${encodeURIComponent(evid)}`;
}

async function getEvidViaAjax(iframeSrc, glParams = null) {
  let parsed;
  try {
    parsed = new URL(iframeSrc.startsWith("//") ? "https:" + iframeSrc : iframeSrc);
  } catch {
    return null;
  }

  const base    = `${parsed.protocol}//${parsed.hostname}`;
  const cookies = getCookies(parsed.hostname) || getCookies("embed.wcostream.com");
  const fullIframe = iframeSrc.startsWith("//") ? "https:" + iframeSrc : iframeSrc;

  const rawFile = parsed.searchParams.get("file") || "";
  const decodedFile = decodeURIComponent(rawFile).replace(/\.flv$/i, ".mp4");
  const embed       = (glParams && glParams.embed) || parsed.searchParams.get("embed") || "ndisk";
  const hd          = (glParams && glParams.hd)    || parsed.searchParams.get("hd")    || "1";
  const vParam      = (glParams && glParams.v)     || decodedFile;

  const getvidlinkUrl =
    `${base}/inc/embed/getvidlink.php?v=${encodeURIComponent(vParam)}&embed=${embed}&hd=${hd}`;

  const ajaxHeaders = {
    "User-Agent": USER_AGENT,
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    Referer: fullIframe,
    Origin: base,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    ...(cookies ? { Cookie: cookies } : {}),
  };

  try {
    console.log(`[AJAX] GET ${getvidlinkUrl}`);
    const resp = await gotScraping({
      url: getvidlinkUrl,
      headers: ajaxHeaders,
      throwHttpErrors: false,
      followRedirect: true,
    });

    const setCookie = resp.headers["set-cookie"] || [];
    if (setCookie.length) {
      mergeCookies(parsed.hostname, setCookie);
      mergeCookies("embed.wcostream.com", setCookie);
    }

    const body = resp.body?.trim() || "";
    console.log(`[AJAX] → ${resp.statusCode} | ${body.slice(0, 500)}`);

    if (resp.statusCode !== 200 || !body) return null;

    let json;
    try { json = JSON.parse(body); } catch (_) { return null; }

    const evid   = json.enc    || null;
    const server = json.server || json.cdn || null;

    if (!evid) {
      console.log("[AJAX] response has no .enc field:", JSON.stringify(json).slice(0, 300));
      return null;
    }

    let cdnHost = "nd02.wcostream.com";
    if (server) {
      try { cdnHost = new URL(server).hostname; } catch (_) {}
    }

    const serverBase  = server || `https://${cdnHost}`;
    const getvidUrl   = getvid(serverBase, evid);

    return {
      evid,
      cdnHost,
      serverBase,
      getvidUrl,
      fhd: json.fhd || null,
      hd:  json.hd  || null,
      sd:  json.sd  || null,
    };

  } catch (err) {
    console.log(`[AJAX] threw: ${err.message}`);
    return null;
  }
}

const SERVER_PARAMS = new Set(["src", "referer", "debug", "url", "iframeSrc", "evid", "host"]);

function reconstructEmbedUrl(req) {
  const src = req.query.src;
  if (!src) return null;
  const extra = [];
  for (const [k, v] of Object.entries(req.query)) {
    if (SERVER_PARAMS.has(k)) continue;
    extra.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  if (extra.length === 0) return src;
  const sep = src.includes("?") ? "&" : "?";
  return src + sep + extra.join("&");
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "WCOstream Proxy API",
    version: "1.2.0",
    endpoints: {
      episodes: { base: "/episodes?url=<anime-page-url>" },
      sources:  { base: "/sources/<episodeId>" },
      stream:   { base: "/stream?url=<episode-url>&q=fhd|hd|sd" },
      scrape:   { base: "/scrape?url=<episode-url>" },
      iframe:   { base: "/iframe?src=<embed-src>&referer=<ep-url>" },
      resolve:  { base: "/resolve?evid=<evid>&host=<cdnHost>" },
      proxy:    { base: "/proxy-stream?url=<stream-url>" },
      m3u8:     { base: "/m3u8?url=<m3u8-url>" },
    },
  });
});

// Tries multiple selectors in order so different WCOstream page layouts all work.
app.get("/episodes", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url param required" });

  try {
    const resp = await scrapeGet(url, {
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
    });

    if (resp.statusCode !== 200) {
      return res.status(resp.statusCode).json({
        error: `HTTP ${resp.statusCode}`,
        bodySnippet: resp.body?.slice(0, 300),
      });
    }

    const $ = cheerio.load(resp.body);

    const title =
      $("h1.h2-tag").text().trim() ||
      $("h1").first().text().trim() ||
      $("title").text().replace(/ -.*$/, "").trim();

    const episodes = [];

    // ── Helper: parse one <a> element into an episode object ─────────────────
    function parseAnchor(el, defaultLang = "sub") {
      const rawHref   = $(el).attr("href") || "";
      const episodeId = rawHref.replace(/^\//, "").replace(/^https?:\/\/[^/]+\//, "");
      if (!episodeId || !rawHref) return null;

      // label: prefer the element's own text, else the href slug
      const label = $(el).text().trim() || episodeId;

      // language: data-lang attr → href keyword → caller default
      const lang =
        $(el).attr("data-lang") ||
        (/english.dub/i.test(rawHref) ? "dub" : /english.sub/i.test(rawHref) ? "sub" : defaultLang);

      // quality badges (layout A) or fall through to sd
      const quality = $(el).find(".badge.fhd, .fhd-badge").length
        ? "fhd"
        : $(el).find(".badge.hd, .hd-badge").length
        ? "hd"
        : "sd";

      const numMatch = label.match(/episode\s+(\d+(?:\.\d+)?)/i) ||
                       episodeId.match(/episode-(\d+(?:-\d+)?)/i);
      const num = numMatch ? parseFloat(numMatch[1].replace("-", ".")) : null;

      return { episodeId, label, lang, quality, num };
    }

    // ── Layout A: #episodeList  (original selector) ───────────────────────────
    $("#episodeList a.dark-episode-item, #episodeList a[href]").each((_, el) => {
      const ep = parseAnchor(el);
      if (ep) episodes.push(ep);
    });

    // ── Layout B: #catlist-listview  (older WCO pages) ────────────────────────
    if (episodes.length === 0) {
      $("#catlist-listview ul li a[href], #catlist-listview li a[href]").each((_, el) => {
        const ep = parseAnchor(el);
        if (ep) episodes.push(ep);
      });
    }

    // ── Layout C: .cat-eps  (some newer pages) ────────────────────────────────
    if (episodes.length === 0) {
      $(".cat-eps a[href], ul.episodes-section li a[href]").each((_, el) => {
        const ep = parseAnchor(el);
        if (ep) episodes.push(ep);
      });
    }

    // ── Layout D: generic  — any <a> whose href looks like an episode URL ─────
    if (episodes.length === 0) {
      $("a[href*='episode'][href*='english']").each((_, el) => {
        const href = $(el).attr("href") || "";
        // skip nav/header links
        if (href.includes("/anime/")) return;
        const ep = parseAnchor(el);
        if (ep) episodes.push(ep);
      });
    }

    // de-duplicate by episodeId
    const seen = new Set();
    const unique = episodes.filter(ep => {
      if (seen.has(ep.episodeId)) return false;
      seen.add(ep.episodeId);
      return true;
    });

    unique.sort((a, b) => {
      if (a.lang !== b.lang) return a.lang === "dub" ? -1 : 1;
      return (a.num || 0) - (b.num || 0);
    });

    res.json({ title, total: unique.length, episodes: unique });
  } catch (err) {
    console.error("[/episodes] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── resolveEpisode — shared play logic ──────────────────────────────────────
async function resolveEpisode(url, iframeSrc = null, debug = false) {
  let iframe = iframeSrc || null;
  let title  = null;

  if (url && !iframe) {
    const resp = await scrapeGet(url, {
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
    });
    if (resp.statusCode !== 200)
      throw Object.assign(new Error(`Episode page returned ${resp.statusCode}`), { statusCode: resp.statusCode });

    const $ = cheerio.load(resp.body);
    title =
      $("h1.video-title").text().trim() ||
      $("h1").first().text().trim() ||
      $("title").text().replace(/ -.*$/, "").trim();
    iframe =
      $("#frameNewVideo").attr("src") ||
      $("iframe[src*='wco']").first().attr("src") ||
      $("iframe[src*='embed']").first().attr("src") ||
      $("iframe").first().attr("src") ||
      null;
  }

  if (!iframe) throw Object.assign(new Error("Could not find iframe src"), { statusCode: 404 });

  const episodeReferer = url || "https://www.wcostream.tv/";
  const fullIframe = iframe.startsWith("//") ? "https:" + iframe : iframe;
  const embedResp  = await scrapeGet(fullIframe, {
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "iframe",
  }, episodeReferer);

  if (debug) {
    console.log("[resolveEpisode] embed status:", embedResp.statusCode);
    console.log("[resolveEpisode] embed body:", embedResp.body?.slice(0, 2000));
  }

  const $e = cheerio.load(embedResp.body);
  let { evid, cdnHost } = extractEvid($e);

  const glParams = extractGetvidlinkParams($e);
  if (glParams.v) console.log(`[resolveEpisode] glParams: v=${glParams.v} embed=${glParams.embed}`);

  let ajaxGetvidUrl = null;
  let serverBase    = `https://${cdnHost}`;
  let fhd = null, hd = null, sd = null;

  if (!evid) {
    console.log("[resolveEpisode] evid not in static HTML — calling getvidlink.php...");
    const ajax = await getEvidViaAjax(fullIframe, glParams);
    if (ajax) {
      evid          = ajax.evid;
      cdnHost       = ajax.cdnHost;
      serverBase    = ajax.serverBase || `https://${cdnHost}`;
      ajaxGetvidUrl = ajax.getvidUrl  || null;
      fhd           = ajax.fhd;
      hd            = ajax.hd;
      sd            = ajax.sd;
    }
  }

  if (!evid) {
    const err = Object.assign(
      new Error("Could not find evid (static HTML or AJAX both failed)"),
      { statusCode: 404, iframeSrc: iframe, bodySnippet: embedResp.body?.slice(0, 800) }
    );
    throw err;
  }

  const streamUrl = ajaxGetvidUrl || getvid(serverBase, evid);

  // resolve to direct MP4/stream URL
  let directUrl = null;
  try {
    const resolveResp = await axios.get(streamUrl + "&json", {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, */*",
        Referer: "https://embed.wcostream.com/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
      },
      validateStatus: () => true,
    });
    const rawBody   = typeof resolveResp.data === "string" ? resolveResp.data.trim() : null;
    const rawDirect = cleanCdnUrl(
      rawBody && rawBody.replace(/^[_|"']+|[_|"']+$/g, "").trim().startsWith("http")
        ? rawBody
        : (resolveResp.data?.url || resolveResp.data?.src || null)
    );
    directUrl = rawDirect
      ? rawDirect.replace(/[?&]json(?:=\d*)?(?=&|$)/, "").replace(/[?&]$/, "")
      : null;
  } catch (_) {}

  const streamBase     = url ? `http://localhost:${PORT}/stream?url=${encodeURIComponent(url)}` : null;
  const qualityStreams  = streamBase
    ? { fhd: `${streamBase}&q=fhd`, hd: `${streamBase}&q=hd`, sd: `${streamBase}&q=sd` }
    : null;
  const qualityGetvidUrls = {
    default: streamUrl,
    fhd: fhd ? getvid(serverBase, fhd) : null,
    hd:  hd  ? getvid(serverBase, hd)  : null,
    sd:  sd  ? getvid(serverBase, sd)  : null,
  };

  const embedSession = getCookies("embed.wcostream.com");
  const playbackSrc  = directUrl || streamUrl;
  const proxyUrl =
    `http://localhost:${PORT}/proxy-stream?url=${encodeURIComponent(playbackSrc)}` +
    (embedSession ? `&cookie=${encodeURIComponent(embedSession)}` : "");

  return { title, evid, cdnHost, iframeSrc: iframe, streamUrl, directUrl, proxyUrl, qualityEvids: { fhd, hd, sd }, qualityGetvidUrls, qualityStreams };
}

// ─── /sources/:episodeId/stream — pipes raw video ────────────────────────────
// Kept as a redirect to /stream since that handler owns CDN piping + range requests.
app.get("/sources/:episodeId/stream", (req, res) => {
  const episodeUrl = `https://www.wcostream.tv/${req.params.episodeId}`;
  const q = req.query.q ? `&q=${req.query.q}` : "";
  res.redirect(307, `/stream?url=${encodeURIComponent(episodeUrl)}${q}`);
});

app.get("/sources/:episodeId", async (req, res) => {
  const episodeUrl = `https://www.wcostream.tv/${req.params.episodeId}`;
  try {
    const data = await resolveEpisode(episodeUrl, null, req.query.debug);
    res.json(data);
  } catch (err) {
    console.error("[/sources] error:", err.message);
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.iframeSrc ? { iframeSrc: err.iframeSrc, bodySnippet: err.bodySnippet } : {}) });
  }
});

// ─── /scrape ──────────────────────────────────────────────────────────────────
app.get("/scrape", async (req, res) => {
  const { url, debug } = req.query;
  if (!url) return res.status(400).json({ error: "url param required" });

  try {
    const resp = await scrapeGet(url, {
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
    });

    if (debug) {
      console.log("STATUS:", resp.statusCode);
      console.log("BODY:", resp.body?.slice(0, 1000));
    }

    if (resp.statusCode !== 200) {
      return res.status(resp.statusCode).json({
        error: `HTTP ${resp.statusCode}`,
        cfMitigated: resp.headers["cf-mitigated"] ?? null,
        bodySnippet: resp.body?.slice(0, 600),
      });
    }

    const $ = cheerio.load(resp.body);
    const title =
      $("h1.video-title").text().trim() ||
      $("h1").first().text().trim() ||
      $("title").text().replace(/ -.*$/, "").trim();

    const iframeSrc =
      $("#frameNewVideo").attr("src") ||
      $("iframe[src*='wco']").first().attr("src") ||
      $("iframe[src*='embed']").first().attr("src") ||
      $("iframe").first().attr("src") ||
      null;

    const { evid } = extractEvid($);

    res.json({ title, iframeSrc, evid });
  } catch (err) {
    console.error("SCRAPE ERROR:", err.message);
    res.status(500).json({ error: err.message, code: err.code });
  }
});

// ─── /iframe ─────────────────────────────────────────────────────────────────
app.get("/iframe", async (req, res) => {
  const { src, referer, debug } = req.query;
  if (!src) return res.status(400).json({ error: "src param required" });

  const rawSrc = reconstructEmbedUrl(req);
  const fullSrc = rawSrc.startsWith("//") ? "https:" + rawSrc : rawSrc;
  const embedReferer = referer || "https://www.wcostream.tv/";

  try {
    const resp = await scrapeGet(fullSrc, {
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "iframe",
    }, embedReferer);

    if (debug) {
      console.log("[/iframe] status:", resp.statusCode);
      console.log("[/iframe] body snippet:", resp.body?.slice(0, 2000));
    }

    const $ = cheerio.load(resp.body);
    let { evid, cdnHost } = extractEvid($);

    let getvidUrl = evid ? `https://${cdnHost}/getvid?evid=${encodeURIComponent(evid)}` : null;

    const glParamsIframe = extractGetvidlinkParams($);
    if (glParamsIframe.v) console.log(`[/iframe] extracted glParams: v=${glParamsIframe.v} embed=${glParamsIframe.embed}`);

    let fhd = null, hd = null, sd = null;

    if (!evid) {
      console.log("[/iframe] evid not in static HTML — calling getvidlink.php...");
      const ajax = await getEvidViaAjax(fullSrc, glParamsIframe);
      if (ajax) {
        evid      = ajax.evid;
        cdnHost   = ajax.cdnHost;
        getvidUrl = ajax.getvidUrl || getvid(`https://${cdnHost}`, evid);
        fhd       = ajax.fhd;
        hd        = ajax.hd;
        sd        = ajax.sd;
      }
    }

    if (!evid) {
      return res.status(404).json({
        error: "Could not find evid in embed page (static or AJAX)",
        hint: "Pass &debug=1 to /iframe to see the raw embed body in server logs",
        bodySnippet: resp.body?.slice(0, 800),
      });
    }

    res.json({ evid, getvidUrl, cdnHost, fhd, hd, sd });
  } catch (err) {
    console.error("IFRAME ERROR:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── /play — one-shot ─────────────────────────────────────────────────────────
app.get("/play", async (req, res) => {
  const { url, iframeSrc, debug } = req.query;
  if (!url && !iframeSrc)
    return res.status(400).json({ error: "url or iframeSrc param required" });
  try {
    const data = await resolveEpisode(url, iframeSrc, debug);
    res.json(data);
  } catch (err) {
    console.error("PLAY ERROR:", err.message);
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.iframeSrc ? { iframeSrc: err.iframeSrc, bodySnippet: err.bodySnippet } : {}) });
  }
});

// ─── /stream ──────────────────────────────────────────────────────────────────
app.get("/stream", async (req, res) => {
  const { url: episodeUrl, q } = req.query;
  if (!episodeUrl) return res.status(400).json({ error: "url param required" });

  const reqCookies = new Map();

  function mergeReqCookies(domain, setCookieHeaders = []) {
    const existing = reqCookies.get(domain) || "";
    const map = Object.fromEntries(
      existing.split(";").map(p => p.trim().split("=")).filter(p => p[0])
    );
    for (const raw of setCookieHeaders) {
      const [pair] = raw.split(";");
      const [k, v] = pair.split("=");
      if (k) map[k.trim()] = (v || "").trim();
    }
    const merged = Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
    reqCookies.set(domain, merged);
    mergeCookies(domain, setCookieHeaders);
    return merged;
  }

  function getReqCookies(domain) {
    return reqCookies.get(domain) || reqCookies.get("embed.wcostream.com") || "";
  }

  async function scopedGet(url, headers = {}, referer = "https://www.wcostream.tv/") {
    const domain  = domainOf(url);
    const cookies = getReqCookies(domain);
    const resp    = await gotScraping({
      url,
      headers: { ...browserHeaders(referer), ...headers, ...(cookies ? { Cookie: cookies } : {}) },
      throwHttpErrors: false,
      followRedirect: true,
    });
    const sc = resp.headers["set-cookie"] || [];
    if (sc.length) mergeReqCookies(domain, sc);
    return resp;
  }

  try {
    const epResp = await scopedGet(episodeUrl, {
      "Sec-Fetch-Site": "same-origin", "Sec-Fetch-User": "?1",
    });
    if (epResp.statusCode !== 200)
      return res.status(502).json({ error: `Episode page returned ${epResp.statusCode}` });

    const $ep  = cheerio.load(epResp.body);
    const iframe =
      $ep("#frameNewVideo").attr("src") ||
      $ep("iframe[src*='wco']").first().attr("src") ||
      $ep("iframe[src*='embed']").first().attr("src") ||
      $ep("iframe").first().attr("src") || null;
    if (!iframe) return res.status(404).json({ error: "No iframe found on episode page" });

    const fullIframe = iframe.startsWith("//") ? "https:" + iframe : iframe;

    const embedResp2 = await scopedGet(fullIframe, {
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "iframe",
    }, episodeUrl);

    const $embed = cheerio.load(embedResp2.body);
    const glParams = extractGetvidlinkParams($embed);

    let parsed;
    try { parsed = new URL(fullIframe); }
    catch { return res.status(400).json({ error: "Bad iframe URL" }); }

    const base = `${parsed.protocol}//${parsed.hostname}`;

    let glV, glEmbed, glHd;
    if (glParams.v) {
      glV     = glParams.v;
      glEmbed = glParams.embed || parsed.searchParams.get("embed") || "ndisk";
      glHd    = glParams.hd   || parsed.searchParams.get("hd")    || "1";
      console.log(`[/stream] using hardcoded getvidlink params from page: v=${glV} embed=${glEmbed}`);
    } else {
      const rawFile = parsed.searchParams.get("file") || "";
      glV     = decodeURIComponent(rawFile).replace(/\.flv$/i, ".mp4");
      glEmbed = parsed.searchParams.get("embed") || "ndisk";
      glHd    = parsed.searchParams.get("hd")    || "1";
      console.log(`[/stream] fallback: constructing v from iframe file param: v=${glV}`);
    }

    const getvidlinkUrl = `${base}/inc/embed/getvidlink.php?v=${encodeURIComponent(glV)}&embed=${glEmbed}&hd=${glHd}`;

    const embedCookies = getReqCookies(parsed.hostname);
    console.log(`[/stream] getvidlink → ${getvidlinkUrl}`);
    console.log(`[/stream] using cookies: ${embedCookies}`);

    const glResp = await gotScraping({
      url: getvidlinkUrl,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: fullIframe,
        Origin: base,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        ...(embedCookies ? { Cookie: embedCookies } : {}),
      },
      throwHttpErrors: false,
    });

    const sc2 = glResp.headers["set-cookie"] || [];
    if (sc2.length) mergeReqCookies(parsed.hostname, sc2);

    console.log(`[/stream] getvidlink status: ${glResp.statusCode} body: ${glResp.body?.slice(0, 400)}`);

    let json;
    try { json = JSON.parse(glResp.body); }
    catch {
      return res.status(502).json({
        error: "getvidlink.php returned non-JSON",
        body: glResp.body?.slice(0, 300),
      });
    }

    const evid   = json.enc;
    const server = json.server || json.cdn;
    if (!evid || !server)
      return res.status(502).json({ error: "getvidlink.php missing enc/server", json });

    // pick quality evid — fall back to default (enc) if the requested quality isn't present
    let chosenEvid = evid;
    if      (q === "fhd" && json.fhd) chosenEvid = json.fhd;
    else if (q === "hd"  && json.hd)  chosenEvid = json.hd;
    else if (q === "sd"  && json.sd)  chosenEvid = json.sd;

    if (q && chosenEvid === evid) {
      console.log(`[/stream] quality "${q}" not available — falling back to default enc`);
    }

    const resolverUrl   = `${server}/getvid?evid=${encodeURIComponent(chosenEvid)}&json`;
    const streamCookies = getReqCookies(parsed.hostname);
    console.log(`[/stream] resolving → ${resolverUrl}`);

    let streamTarget = `${server}/getvid?evid=${encodeURIComponent(chosenEvid)}`;

    try {
      const resolveResp = await axios.get(resolverUrl, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json, */*",
          Referer: "https://embed.wcostream.com/",
          Origin: "https://embed.wcostream.com",
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-site",
          ...(streamCookies ? { Cookie: streamCookies } : {}),
        },
        validateStatus: () => true,
        maxRedirects: 5,
      });
      console.log(`[/stream] resolver status: ${resolveResp.status} | ${JSON.stringify(resolveResp.data)?.slice(0, 200)}`);

      const resolvedBody = resolveResp.data;
      let resolvedUrl = null;
      if (typeof resolvedBody === "string") {
        const cleaned = cleanCdnUrl(resolvedBody);
        if (cleaned && cleaned.startsWith("http")) resolvedUrl = cleaned;
      } else if (resolvedBody?.url) {
        resolvedUrl = cleanCdnUrl(resolvedBody.url);
      } else if (resolvedBody?.src) {
        resolvedUrl = cleanCdnUrl(resolvedBody.src);
      }
      if (resolvedUrl) {
        resolvedUrl = resolvedUrl.replace(/[?&]json(?:=\d*)?(?=&|$)/, "").replace(/[?&]$/, "");
        streamTarget = resolvedUrl;
        console.log(`[/stream] resolved to: ${streamTarget}`);
      }
    } catch (resolveErr) {
      console.log(`[/stream] resolver threw: ${resolveErr.message} — using fallback URL`);
    }

    console.log(`[/stream] streaming → ${streamTarget}`);

    const upstream = await axios.get(streamTarget, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
        Referer: "https://embed.wcostream.com/",
        Origin: "https://embed.wcostream.com",
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-site",
        ...(streamCookies ? { Cookie: streamCookies } : {}),
        ...(req.headers["range"] ? { Range: req.headers["range"] } : {}),
      },
      responseType: "stream",
      maxRedirects: 10,
      validateStatus: () => true,
    });

    console.log(`[/stream] CDN status: ${upstream.status}`);

    if (upstream.status === 404)
      return res.status(404).json({
        error: "CDN returned 404 — evid rejected",
        streamTarget,
        cookies: streamCookies,
        json,
      });
    if (upstream.status >= 400)
      return res.status(upstream.status).json({
        error: `CDN returned ${upstream.status}`,
        streamTarget,
      });

    res.status(upstream.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"])
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
    upstream.data.pipe(res);

  } catch (err) {
    console.error("[/stream] error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── /getvid ─────────────────────────────────────────────────────────────────
app.get("/getvid", async (req, res) => {
  const { evid, host } = req.query;
  if (!evid) return res.status(400).json({ error: "evid param required" });

  const cdnHost = host || "nd02.wcostream.com";
  const target  = `https://${cdnHost}/getvid?evid=${encodeURIComponent(evid)}`;

  try {
    const response = await axios.get(target, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.7",
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-site",
        Referer: "https://embed.wcostream.com/",
      },
      validateStatus: () => true,
    });
    res.status(response.status).json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /resolve ─────────────────────────────────────────────────────────────────
app.get("/resolve", async (req, res) => {
  const { evid, host } = req.query;
  if (!evid) return res.status(400).json({ error: "evid param required" });

  const cdnHost  = host || "nd02.wcostream.com";
  const jsonUrl  = `https://${cdnHost}/getvid?evid=${encodeURIComponent(evid)}&json`;
  const plainUrl = `https://${cdnHost}/getvid?evid=${encodeURIComponent(evid)}`;

  try {
    const response = await axios.get(jsonUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json, */*",
        Referer: "https://embed.wcostream.com/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
      },
      validateStatus: () => true,
    });

    const rawBody   = typeof response.data === "string" ? response.data.trim() : null;
    const directUrl = cleanCdnUrl(
      rawBody && cleanCdnUrl(rawBody)?.startsWith("http")
        ? rawBody
        : (response.data?.url || response.data?.src || null)
    );

    res.json({ directUrl, fallbackUrl: plainUrl, evid, cdnHost });
  } catch (err) {
    res.status(500).json({ error: err.message, fallbackUrl: plainUrl });
  }
});

// ─── /m3u8 + /proxy-stream ────────────────────────────────────────────────────
app.get("/m3u8", async (req, res) => {
  const { url: m3u8Url } = req.query;
  if (!m3u8Url) return res.status(400).json({ error: "url param required" });
  try {
    const resp = await scrapeGet(m3u8Url, { Referer: "https://embed.wcostream.com/" });
    const base = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
    const rewritten = resp.body.split("\n").map((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return line;
      const abs = t.startsWith("http") ? t : base + t;
      return `http://localhost:${PORT}/proxy-stream?url=${encodeURIComponent(abs)}`;
    }).join("\n");
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(rewritten);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/proxy-stream", async (req, res) => {
  let { url: streamUrl, cookie: sessionCookie } = req.query;
  if (!streamUrl) return res.status(400).json({ error: "url param required" });
  streamUrl = streamUrl
    .replace(/^[_|"']+|[_|"']+$/g, "")
    .replace(/[?&]json(?:=\d*)?(?=&|$)/, "")
    .replace(/[?&]$/, "");

  const embedCookie = sessionCookie
    || getCookies("embed.wcostream.com")
    || getCookies(domainOf(streamUrl));

  try {
    const upstream = await axios.get(streamUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "video/mp4,video/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.7",
        Referer: "https://embed.wcostream.com/",
        Origin: "https://embed.wcostream.com",
        "Sec-Fetch-Dest": "video",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "same-site",
        ...(embedCookie ? { Cookie: embedCookie } : {}),
        ...(req.headers["range"] ? { Range: req.headers["range"] } : {}),
      },
      responseType: "stream",
      maxRedirects: 5,
    });
    res.status(upstream.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"])
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
    upstream.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /debug-embed ─────────────────────────────────────────────────────────────
app.get("/debug-embed", async (req, res) => {
  const { src, referer } = req.query;
  if (!src) return res.status(400).json({ error: "src param required" });
  const rawSrc = reconstructEmbedUrl(req);
  const fullSrc = rawSrc.startsWith("//") ? "https:" + rawSrc : rawSrc;
  const embedReferer = referer || "https://www.wcostream.tv/";

  try {
    const resp = await scrapeGet(fullSrc, {
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "iframe",
    }, embedReferer);

    const $ = cheerio.load(resp.body);
    const scripts = [];
    $("script").each((i, el) => {
      const code = $(el).html() || "";
      if (code.trim()) scripts.push({ index: i, snippet: code.slice(0, 3000) });
    });

    res.json({
      statusCode: resp.statusCode,
      cookies: getCookies(domainOf(fullSrc)),
      bodyLength: resp.body?.length,
      bodySnippet: resp.body?.slice(0, 1500),
      scriptCount: scripts.length,
      scripts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /:episodeId — shorthand for /play (no redirect) ─────────────────────────
// Must stay last so it can't shadow any named route above.
app.get("/:episodeId", async (req, res, next) => {
  const { episodeId } = req.params;
  if (episodeId.includes(".") || episodeId.length < 5) return next();
  const episodeUrl = `https://www.wcostream.tv/${episodeId}`;
  try {
    const data = await resolveEpisode(episodeUrl, null, req.query.debug);
    res.json(data);
  } catch (err) {
    console.error("[/:episodeId] error:", err.message);
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.iframeSrc ? { iframeSrc: err.iframeSrc, bodySnippet: err.bodySnippet } : {}) });
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  http://localhost:${PORT}  ← open in browser for full endpoint index`);
  console.log("  /:episodeId                                  ← shorthand /play (new)");
  console.log("  /episodes?url=<anime-page-url>               ← episode list as JSON  (episodeId field)");
  console.log("  /sources/:episodeId                          ← play info (replaces /play?url=...)");
  console.log("  /sources/:episodeId/stream?q=fhd|hd|sd       ← pipe video at chosen quality");
  console.log("  /play?url=<episode-url>                      ← one-shot → streamUrl + qualityStreams");
  console.log("  /stream?url=<episode-url>&q=fhd|hd|sd        ← pipe video at chosen quality");
  console.log("  /scrape  /iframe  /resolve  /proxy-stream  /m3u8  /debug-embed\n");
});