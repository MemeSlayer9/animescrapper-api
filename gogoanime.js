const express = require("express");
const axios   = require("axios");
const cheerio = require("cheerio");
const cors    = require("cors");
const path    = require("path");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const HEADERS = {
  "User-Agent"     : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept"         : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.5",
};

/* ─────────────────────────────────────────────────────────────
   /scrape  →  returns:
     embedUrl  – the n-bg iframe (safest, plays in an iframe)
     sources   – [{ file, label, proxyUrl }]
                 file     = original googlevideo URL (server-IP bound)
                 proxyUrl = /proxy?url=<encoded file>  ← use this in <video>
     thumbnail
   KEY INSIGHT:
     The original googlevideo URL (ip=SERVER_IP, no ipbypass) is what
     the server can fetch. We proxy those bytes to the browser.
     Never try to use the 302-redirect "ipbypass" URL from the browser —
     that URL is bound to the browser IP and will 403 from any other origin.
───────────────────────────────────────────────────────────── */
app.get("/scrape", async (req, res) => {
  const pageUrl =
    req.query.url ||
    "https://gogoanime.by/detective-conan-episode-1197-english-subbed/";

  try {
    /* Step 1 – Main page */
    const { data: html } = await axios.get(pageUrl, { headers: HEADERS });
    const $ = cheerio.load(html);

    /* Step 2 – Extract encrypted params */
    let scriptContent = "";
    $("script:not([src])").each((_, el) => {
      const c = $(el).html() || "";
      if (c.includes("9animetv.be") || c.includes("player.php"))
        scriptContent = c;
    });

    const extract = (key) => {
      const m = scriptContent.match(new RegExp(`const ${key}\\s*=\\s*"([^"]+)"`));
      return m ? m[1] : null;
    };

    const type       = extract("defaultType");
    const enc1       = extract("defaultEnc1");
    const enc2       = extract("defaultEnc2");
    const enc3       = extract("defaultEnc3");
    const postId     = extract("defaultPostId");
    const featureImg = extract("defaultFeatureImage");

    if (!type || !enc1)
      return res.status(422).json({ error: "Could not extract player params." });

    /* Step 3 – player.php → iframe src */
    const params1 = new URLSearchParams({
      [type]: enc1, url2: enc2, url3: enc3,
      feature_image: featureImg,
      user_agent: HEADERS["User-Agent"],
      ref: "gogoanime.by",
      postId,
    });

    const playerPhpUrl = `https://9animetv.be/wp-content/plugins/video-player/includes/player/player.php?${params1}`;
    const { data: playerHtml } = await axios.get(playerPhpUrl, {
      headers: { ...HEADERS, Referer: "https://gogoanime.by/" },
    });

    const $p = cheerio.load(playerHtml);
    const iframeSrc = $p("iframe").attr("src");
    if (!iframeSrc)
      return res.status(422).json({ error: "iframe not found in player.php." });

    /* Step 4 – n-bg/player.php → JW Player config */
    const { data: nbgHtml } = await axios.get(iframeSrc, {
      headers: { ...HEADERS, Referer: "https://9animetv.be/" },
    });

    /* Step 5 – Parse sources — keep the ORIGINAL URLs, no redirect following */
    const sourcesMatch = nbgHtml.match(/var sources\s*=\s*(\[.*?\]);/s);
    let sources = [];
    if (sourcesMatch) {
      try { sources = JSON.parse(sourcesMatch[1]); } catch (_) {}
    }

    if (!sources.length) {
      const rawUrls = [...new Set(
        (nbgHtml.match(/https?:\/\/[^\s"'\\]+/g) || []).filter(u =>
          u.includes("googlevideo") || u.includes("blogger") ||
          u.includes(".mp4") || u.includes(".m3u8")
        )
      )];
      sources = rawUrls.map((u, i) => ({
        file: u, label: `Source ${i + 1}`, default: i === 0,
      }));
    }

    const thumbMatch = nbgHtml.match(/var thumbUrl\s*=\s*"([^"]+)"/);
    const thumbnail  = thumbMatch ? thumbMatch[1] : (featureImg || null);

    /* Step 6 – Annotate each source with a /proxy URL.
       The original `file` URL is bound to this server's IP (196.51.200.124).
       Only this server can fetch it — so we proxy the bytes to the browser.
       DO NOT redirect-follow here; the redirected ipbypass URL is browser-IP bound
       and will 403 when fetched by the server.                               */
    const annotated = sources.map(s => ({
      ...s,
      // proxyUrl is what the <video> tag should use
      proxyUrl: `/proxy?url=${encodeURIComponent(s.file)}`,
    }));

    return res.json({ embedUrl: iframeSrc, sources: annotated, thumbnail });

  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   /proxy  – stream the original (server-IP-bound) googlevideo URL
   The server IS the authorised client for these URLs.
   Full range-request support so the browser can seek.
───────────────────────────────────────────────────────────── */
app.get("/proxy", async (req, res) => {
  const videoUrl = req.query.url;

  if (!videoUrl || !/^https:\/\/[^/]*googlevideo\.com\//.test(videoUrl))
    return res.status(400).json({ error: "Invalid url param." });

  try {
    const upstream = await axios({
      method      : "get",
      url         : videoUrl,
      headers     : {
        ...HEADERS,
        // Forward range header so seeking works
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
      responseType: "stream",
      // IMPORTANT: do NOT follow redirects automatically here.
      // If Google returns a 302 the redirect target will be the
      // ipbypass URL bound to THIS server's IP (same IP = fine),
      // but let's be explicit and follow up to 3 hops only.
      maxRedirects: 3,
      validateStatus: s => s < 400,
    });

    res.status(upstream.status === 206 ? 206 : 200);

    const fwd = ["content-type","content-length","content-range","accept-ranges"];
    fwd.forEach(h => upstream.headers[h] && res.setHeader(h, upstream.headers[h]));
    res.setHeader("Accept-Ranges", "bytes");

    upstream.data.pipe(res);
  } catch (err) {
    console.error("Proxy error:", err.message);
    // Surface the upstream status code if available
    const status = err.response?.status || 502;
    if (!res.headersSent)
      res.status(status).json({ error: err.message, upstream: status });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅  http://localhost:${PORT}`));