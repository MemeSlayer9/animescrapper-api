import express from "express";
import cors from "cors";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const http = axios.create({
  timeout: 20000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
  },
});

// ── SvelteKit devalue decoder ─────────────────────────────────────────────────
function devalue(arr) {
  const seen = new Map();
  function hydrate(i) {
    if (seen.has(i)) return seen.get(i);
    const val = arr[i];
    if (val === null || typeof val !== "object") return val;
    if (Array.isArray(val)) {
      const result = [];
      seen.set(i, result);
      val.forEach((v, idx) => (result[idx] = typeof v === "number" && v !== i ? hydrate(v) : v));
      return result;
    }
    const result = {};
    seen.set(i, result);
    for (const [k, v] of Object.entries(val)) {
      result[k] = typeof v === "number" ? hydrate(v) : v;
    }
    return result;
  }
  return hydrate(0);
}

// ── Fetch SvelteKit __data.json ───────────────────────────────────────────────
async function getSvelteKitData(slug, ep, lang, cookie) {
  const url = `https://reanime.to/watch/${slug}/__data.json?ep=${ep}&lang=${lang}&x-sveltekit-invalidated=011`;
  const headers = {
    Referer: `https://reanime.to/watch/${slug}?ep=${ep}&lang=${lang}`,
    Accept: "application/json",
  };
  if (cookie) headers["Cookie"] = cookie;
  const { data } = await http.get(url, { headers });
  const node = data.nodes.find(
    (n) => n.type === "data" && Array.isArray(n.data) && n.data.length > 10
  );
  if (!node) throw new Error("No data node found in __data.json");
  return devalue(node.data);
}

// ── Extract all UUIDs from an object ─────────────────────────────────────────
function extractAllUuids(obj) {
  const ids = new Set();
  const json = JSON.stringify(obj ?? {});
  for (const [uuid] of json.matchAll(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  )) {
    ids.add(uuid);
  }
  return [...ids];
}

// ── Pull m3u8-like URL from any string ───────────────────────────────────────
function findM3u8(text) {
  if (!text) return null;
  const s = typeof text === "string" ? text : JSON.stringify(text);
  const cdn = s.match(/https?:\/\/fetch\d*\.flixcloud\.cc\/[^"'`\s\\]+/)?.[0];
  if (cdn) return cdn.replace(/\\/g, "");
  const m3u8 = s.match(/https?:\/\/[^"'`\s\\]+\.m3u8[^"'`\s\\]*/)?.[0];
  if (m3u8) return m3u8.replace(/\\/g, "");
  return null;
}

// ── Flixcloud resolver (no puppeteer) ─────────────────────────────────────────
async function flixcloudM3u8(videoId, siteReferer = "https://reanime.to/") {
  console.log("[FC] resolving videoId:", videoId);

  const embedHeaders = {
    Referer: siteReferer,
    Origin: "https://reanime.to",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Sec-Fetch-Dest": "iframe",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
  };
  const fcXhrHeaders = {
    Referer: `https://flixcloud.cc/e/${videoId}`,
    Origin: "https://flixcloud.cc",
    Accept: "application/json, */*;q=0.8",
    "X-Requested-With": "XMLHttpRequest",
  };

  // ── STEP 1: fetch embed page ──────────────────────────────────────────────
  const embedUrl = `https://flixcloud.cc/e/${videoId}`;
  let html = "";
  try {
    const { data, status } = await http.get(embedUrl, {
      headers: embedHeaders,
      validateStatus: () => true,
    });
    if (status < 400 && typeof data === "string") html = data;
    else console.log("[FC EMBED] status:", status);
  } catch (e) {
    console.log("[FC EMBED ERR]", e.message);
  }

  if (html) {
    // 1a. Direct CDN / m3u8 in raw HTML
    const direct = findM3u8(html);
    if (direct) {
      console.log("[FC] found m3u8 directly in embed HTML");
      return { m3u8: direct, videoId, source: embedUrl };
    }

    // 1b. Inline JSON blobs
    const jsonPatterns = [
      /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
      /window\.__(?:NUXT|DATA|INITIAL_STATE|PLAYER_CONFIG|CONFIG|SOURCES?|APP_STATE)\s*=\s*(\{[\s\S]*?\});/gi,
      /self\.__next_f\s*=\s*(\[[\s\S]*?\]);/gi,
      /var\s+(?:playerConfig|config|sources?|setup)\s*=\s*(\{[\s\S]*?\});/gi,
      /JSON\.parse\(['"`]((?:\\.|[^'"`])*?)['"`]\)/gi,
    ];

    for (const re of jsonPatterns) {
      for (const [, blob] of html.matchAll(re)) {
        let decoded = blob;
        if (re.source.includes("JSON\\.parse")) {
          try { decoded = JSON.parse(`"${blob}"`); }
          catch { decoded = blob.replace(/\\"/g, '"').replace(/\\\\/g, "\\"); }
        }
        try {
          const parsed = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
          const m3u8 = findM3u8(JSON.stringify(parsed));
          if (m3u8) {
            console.log("[FC] found m3u8 in inline JSON blob");
            return { m3u8, videoId, source: embedUrl + " (inline JSON)" };
          }
        } catch {}
      }
    }

    // 1c. Fetch external JS bundles → find API path
    const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map(([, src]) => src.startsWith("http") ? src : `https://flixcloud.cc${src}`)
      .filter((s) => s.includes("flixcloud.cc"))
      .slice(0, 6);

    for (const src of scriptSrcs) {
      try {
        const { data: js } = await http.get(src, {
          headers: { ...fcXhrHeaders, Accept: "*/*" },
          validateStatus: () => true,
        });
        if (typeof js !== "string") continue;

        const baked = findM3u8(js);
        if (baked) {
          console.log("[FC] found m3u8 baked in JS bundle:", src);
          return { m3u8: baked, videoId, source: src };
        }

        const apiPaths = [
          ...js.matchAll(/["'`](\/api\/v?\d+\/(?:source|video|stream|token)[^"'`]*?)["'`]/gi),
        ].map(([, p]) => p);

        for (const apiPath of apiPaths.slice(0, 8)) {
          const resolved = apiPath
            .replace(/:id\b/, videoId)
            .replace(/\{id\}/, videoId)
            .replace(/\[id\]/, videoId);
          const apiUrl = resolved.startsWith("http")
            ? resolved
            : `https://flixcloud.cc${resolved}`;
          try {
            console.log("[FC JS API TRY]", apiUrl);
            const { data: resp, status } = await http.get(apiUrl, {
              headers: fcXhrHeaders,
              validateStatus: () => true,
            });
            if (status >= 400) continue;
            const m3u8 = findM3u8(resp);
            if (m3u8) {
              console.log("[FC] found m3u8 via JS bundle API:", apiUrl);
              return { m3u8, videoId, source: apiUrl };
            }
          } catch {}
        }
      } catch (e) {
        console.log("[FC JS BUNDLE ERR]", src, e.message);
      }
    }
  }

  // ── STEP 2: brute-force API endpoints ────────────────────────────────────
  const apiCandidates = [
    { method: "GET",  url: `https://flixcloud.cc/api/v7/source/${videoId}` },
    { method: "GET",  url: `https://flixcloud.cc/api/v7/sources/${videoId}` },
    { method: "GET",  url: `https://flixcloud.cc/api/v7/video/${videoId}` },
    { method: "GET",  url: `https://flixcloud.cc/api/v7/stream/${videoId}` },
    { method: "GET",  url: `https://flixcloud.cc/api/v7/token/${videoId}` },
    { method: "GET",  url: `https://flixcloud.cc/api/v1/source/${videoId}` },
    { method: "GET",  url: `https://flixcloud.cc/api/v1/video/${videoId}` },
    { method: "GET",  url: `https://flixcloud.cc/api/source/${videoId}` },
    { method: "GET",  url: `https://flixcloud.cc/api/video/${videoId}` },
    { method: "GET",  url: `https://flixcloud.cc/api/stream/${videoId}` },
    { method: "POST", url: `https://flixcloud.cc/api/source`,    data: { id: videoId } },
    { method: "POST", url: `https://flixcloud.cc/api/v7/source`, data: { id: videoId } },
    { method: "POST", url: `https://flixcloud.cc/api/source`,    data: { videoId } },
    { method: "POST", url: `https://flixcloud.cc/api/sources`,   data: { videoId } },
  ];

  for (const api of apiCandidates) {
    try {
      console.log("[FC API TRY]", api.method, api.url);
      const resp =
        api.method === "POST"
          ? await http.post(api.url, api.data, { headers: fcXhrHeaders, validateStatus: () => true })
          : await http.get(api.url, { headers: fcXhrHeaders, validateStatus: () => true });
      if (resp.status >= 400) { console.log("[FC API SKIP]", resp.status); continue; }
      const m3u8 = findM3u8(resp.data);
      if (m3u8) {
        console.log("[FC API HIT]", api.url, "→", m3u8.slice(0, 80));
        return { m3u8, videoId, source: api.url };
      }
      console.log("[FC API NO M3U8]", api.url, JSON.stringify(resp.data).slice(0, 150));
    } catch (e) {
      console.log("[FC API ERR]", api.url, e.message);
    }
  }

  // ── STEP 3: alternate embed paths ─────────────────────────────────────────
  for (const u of [`https://flixcloud.cc/embed/${videoId}`, `https://flixcloud.cc/v/${videoId}`, `https://flixcloud.cc/play/${videoId}`]) {
    try {
      const { data, status } = await http.get(u, { headers: embedHeaders, validateStatus: () => true });
      if (status >= 400 || typeof data !== "string") continue;
      const m3u8 = findM3u8(data);
      if (m3u8) { console.log("[FC ALT EMBED HIT]", u); return { m3u8, videoId, source: u }; }
    } catch {}
  }

  console.log("[FC] all strategies exhausted for", videoId);
  return null;
}

// ── Main resolver ─────────────────────────────────────────────────────────────
async function resolve(slug, ep, lang, cookie) {
  const pageProps = await getSvelteKitData(slug, ep, lang, cookie);
  const title = pageProps?.seo?.title || `Episode ${ep}`;
  const image = pageProps?.anime?.cover_image?.large || null;
  const episodeSources = pageProps?.episodeSources;
  const folder = episodeSources?.folder;
  const server = episodeSources?.progress?.server || "";
  const siteReferer = `https://reanime.to/watch/${slug}?ep=${ep}&lang=${lang}`;

  console.log("[RESOLVE] folder:", folder, "server:", server);

  if (!folder) {
    return {
      error: "episodeSources.folder is empty — authentication required",
      hint: "Pass ?cookie=<value> from DevTools → Application → Cookies",
      can_watch: pageProps?.anime?.can_watch,
      episodeSources,
    };
  }

  const allUuids = extractAllUuids(episodeSources);
  const orderedIds = UUID_RE.test(folder)
    ? [folder, ...allUuids.filter((u) => u !== folder)]
    : allUuids;

  console.log("[RESOLVE] trying UUIDs:", orderedIds);

  for (const vid of orderedIds) {
    const fcResult = await flixcloudM3u8(vid, siteReferer);
    if (fcResult?.m3u8) {
      return {
        title, image,
        m3u8: fcResult.m3u8,
        proxyM3u8: `/proxy/m3u8?url=${encodeURIComponent(fcResult.m3u8)}`,
        videoId: vid, server,
        source: fcResult.source,
        note: "Token is IP-bound to this server. Use proxyM3u8 in your player.",
      };
    }
  }

  // Fallback: reanime.to source APIs
  const h = {
    Referer: siteReferer, Origin: "https://reanime.to",
    Accept: "application/json", "X-Requested-With": "XMLHttpRequest",
  };
  if (cookie) h["Cookie"] = cookie;

  for (const apiUrl of [
    `https://reanime.to/api/watch/${slug}/sources?ep=${ep}&lang=${lang}`,
    `https://reanime.to/api/watch/${slug}/sources?episodeId=ep-${ep}&lang=${lang}`,
    `https://reanime.to/api/episode/sources?episodeId=ep-${ep}&lang=${lang}`,
    `https://reanime.to/api/sources?slug=${slug}&ep=${ep}&lang=${lang}`,
  ]) {
    try {
      const { data, status } = await http.get(apiUrl, { headers: h, validateStatus: () => true });
      if (status !== 200) continue;
      const m3u8 = findM3u8(data);
      if (m3u8) return { title, image, m3u8, source: apiUrl };
      const json = JSON.stringify(data);
      const fcMatch = json.match(/https?:\\?\/\\?\/(?:flixcloud\.cc|[^"\\]*flixcloud)[^"\\]*/)?.[0];
      if (fcMatch) {
        const vidId = fcMatch.replace(/\\/g, "").match(UUID_RE)?.[0];
        if (vidId) {
          const fcResult = await flixcloudM3u8(vidId, siteReferer);
          if (fcResult?.m3u8) return {
            title, image,
            m3u8: fcResult.m3u8,
            proxyM3u8: `/proxy/m3u8?url=${encodeURIComponent(fcResult.m3u8)}`,
            videoId: vidId, source: fcResult.source,
          };
        }
      }
    } catch {}
  }

  return {
    error: "Could not resolve m3u8",
    folder, server,
    triedUuids: orderedIds,
    episodeSources,
    hint: "Run /debug/flixcloud?videoId=<uuid> to probe all endpoints",
  };
}

// ── /anime ────────────────────────────────────────────────────────────────────
app.get("/anime", async (req, res) => {
  const { url, cookie } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const u = new URL(url);
    const slug = (u.pathname.match(/\/watch\/([^/?#]+)/) || [])[1];
    const ep = u.searchParams.get("ep") || "1";
    const lang = u.searchParams.get("lang") || "sub";
    if (!slug) return res.status(400).json({ error: "Could not parse slug" });
    const result = await resolve(slug, ep, lang, cookie);
    res.status(result.m3u8 ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ── /proxy/m3u8 ───────────────────────────────────────────────────────────────
app.get("/proxy/m3u8", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("url required");
  try {
    const { data: text } = await http.get(url, {
      headers: { Referer: "https://flixcloud.cc/", Origin: "https://flixcloud.cc" },
      responseType: "text",
    });
    const base = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
    const rewritten = text.replace(/(https?:\/\/[^\s]+)/g, (match) => {
      if (match.includes(req.headers.host)) return match;
      return `${base}/proxy/seg?url=${encodeURIComponent(match)}`;
    });
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");
    res.send(rewritten);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /proxy/seg ────────────────────────────────────────────────────────────────
app.get("/proxy/seg", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("url required");
  try {
    const { data, headers } = await http.get(url, {
      headers: { Referer: "https://flixcloud.cc/", Origin: "https://flixcloud.cc" },
      responseType: "arraybuffer",
    });
    res.setHeader("Content-Type", headers["content-type"] || "application/octet-stream");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(Buffer.from(data));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /debug/flixcloud ──────────────────────────────────────────────────────────
app.get("/debug/flixcloud", async (req, res) => {
  const { videoId, referer: customReferer } = req.query;
  if (!videoId) return res.status(400).json({ error: "videoId (UUID) required" });

  const siteReferer = customReferer || "https://reanime.to/";
  const fcXhrHeaders = {
    Referer: `https://flixcloud.cc/e/${videoId}`,
    Origin: "https://flixcloud.cc",
    Accept: "application/json, */*",
    "X-Requested-With": "XMLHttpRequest",
  };
  const embedHeaders = {
    Referer: siteReferer, Origin: "https://reanime.to",
    Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
  };

  const candidates = [
    { method: "GET",  url: `https://flixcloud.cc/e/${videoId}`,              headers: embedHeaders },
    { method: "GET",  url: `https://flixcloud.cc/embed/${videoId}`,          headers: embedHeaders },
    { method: "GET",  url: `https://flixcloud.cc/v/${videoId}`,              headers: embedHeaders },
    { method: "GET",  url: `https://flixcloud.cc/api/v7/source/${videoId}`,  headers: fcXhrHeaders },
    { method: "GET",  url: `https://flixcloud.cc/api/v7/video/${videoId}`,   headers: fcXhrHeaders },
    { method: "GET",  url: `https://flixcloud.cc/api/v7/stream/${videoId}`,  headers: fcXhrHeaders },
    { method: "GET",  url: `https://flixcloud.cc/api/v7/token/${videoId}`,   headers: fcXhrHeaders },
    { method: "GET",  url: `https://flixcloud.cc/api/v1/source/${videoId}`,  headers: fcXhrHeaders },
    { method: "GET",  url: `https://flixcloud.cc/api/source/${videoId}`,     headers: fcXhrHeaders },
    { method: "GET",  url: `https://flixcloud.cc/api/video/${videoId}`,      headers: fcXhrHeaders },
    { method: "POST", url: `https://flixcloud.cc/api/source`,  data: { id: videoId }, headers: fcXhrHeaders },
    { method: "POST", url: `https://flixcloud.cc/api/v7/source`, data: { id: videoId }, headers: fcXhrHeaders },
    { method: "POST", url: `https://flixcloud.cc/api/sources`, data: { videoId },     headers: fcXhrHeaders },
  ];

  const results = await Promise.allSettled(candidates.map(async (c) => {
    const resp = c.method === "POST"
      ? await http.post(c.url, c.data, { headers: c.headers, validateStatus: () => true })
      : await http.get(c.url, { headers: c.headers, validateStatus: () => true });
    const isHtml = typeof resp.data === "string" && resp.data.trimStart().startsWith("<");
    const body = isHtml
      ? { html_snippet: resp.data.slice(0, 800), has_m3u8: resp.data.includes(".m3u8"), has_fetch1: resp.data.includes("fetch1.flixcloud") }
      : (typeof resp.data === "object" ? resp.data : String(resp.data).slice(0, 800));
    return { ...c, status: resp.status, contentType: resp.headers["content-type"], body, m3u8Found: findM3u8(resp.data) };
  }));

  res.json(results.map((r, i) => ({
    url: candidates[i].url, method: candidates[i].method,
    ...(r.status === "fulfilled" ? r.value : { error: r.reason?.message }),
  })));
});

// ── /debug/props ──────────────────────────────────────────────────────────────
app.get("/debug/props", async (req, res) => {
  const { url, cookie } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const u = new URL(url);
    const slug = (u.pathname.match(/\/watch\/([^/?#]+)/) || [])[1];
    const ep = u.searchParams.get("ep") || "1";
    const lang = u.searchParams.get("lang") || "sub";
    const props = await getSvelteKitData(slug, ep, lang, cookie);
    res.json({
      pagePropsKeys: Object.keys(props || {}),
      episodeSources: props?.episodeSources,
      folder: props?.episodeSources?.folder,
      server: props?.episodeSources?.progress?.server,
      can_watch: props?.anime?.can_watch,
      currentEpisode: props?.currentEpisode,
      firstEpisode: (props?.episodes || [])[0],
      allUuidsInEpisodeSources: extractAllUuids(props?.episodeSources),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /debug/sources ────────────────────────────────────────────────────────────
app.get("/debug/sources", async (req, res) => {
  const { url, cookie } = req.query;
  if (!url) return res.status(400).json({ error: "url required" });

  const u = new URL(url);
  const slug = (u.pathname.match(/\/watch\/([^/?#]+)/) || [])[1];
  const ep = u.searchParams.get("ep") || "1";
  const lang = u.searchParams.get("lang") || "sub";

  let svelteProps = null, svelteError = null;
  try { svelteProps = await getSvelteKitData(slug, ep, lang, cookie); }
  catch (e) { svelteError = e.message; }

  const h = {
    Referer: `https://reanime.to/watch/${slug}?ep=${ep}&lang=${lang}`,
    Origin: "https://reanime.to", Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (cookie) h["Cookie"] = cookie;

  const apiCandidates = [
    `https://reanime.to/api/watch/${slug}/sources?ep=${ep}&lang=${lang}`,
    `https://reanime.to/api/watch/${slug}/sources?episodeId=ep-${ep}&lang=${lang}`,
    `https://reanime.to/api/episode/sources?episodeId=ep-${ep}&lang=${lang}`,
    `https://reanime.to/api/sources?episodeId=ep-${ep}&lang=${lang}`,
    `https://reanime.to/api/sources?slug=${slug}&ep=${ep}&lang=${lang}`,
    `https://reanime.to/api/v1/watch/${slug}?ep=${ep}&lang=${lang}`,
  ];

  const apiResults = await Promise.allSettled(apiCandidates.map(async (apiUrl) => {
    const { data, status, headers } = await http.get(apiUrl, { headers: h, validateStatus: () => true });
    return { url: apiUrl, status, contentType: headers["content-type"],
      data: typeof data === "string" ? data.slice(0, 500) : data,
      m3u8Found: findM3u8(data) };
  }));

  res.json({
    slug, ep, lang,
    svelteKit: {
      error: svelteError,
      folder: svelteProps?.episodeSources?.folder,
      server: svelteProps?.episodeSources?.progress?.server,
      can_watch: svelteProps?.anime?.can_watch,
      episodeSources: svelteProps?.episodeSources,
      allUuids: extractAllUuids(svelteProps?.episodeSources),
    },
    reanimeApis: apiResults.map((r, i) => ({
      url: apiCandidates[i],
      ...(r.status === "fulfilled" ? r.value : { error: r.reason?.message }),
    })),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));