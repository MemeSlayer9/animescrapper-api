const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Referer': 'https://animotvslash.p2pplay.pro/',
  'Origin': 'https://animotvslash.p2pplay.pro',
};

async function getVideoId(episodeUrl) {
  const { data: html } = await axios.get(episodeUrl, {
    headers: { ...HEADERS, Referer: 'https://animotvslash.org/' }
  });
  const $ = cheerio.load(html);
  const iframeSrc = $('iframe').first().attr('src') || $('iframe').first().attr('data-src') || '';
  const hashMatch = iframeSrc.match(/#([a-z0-9]+)$/i);
  const pathMatch = iframeSrc.match(/\/([a-z0-9]{4,})(?:[/?#]|$)/i);
  return { iframeSrc, videoId: (hashMatch || pathMatch)?.[1] || null };
}

async function fetchStreamUrl(videoId) {
  const { data: folderRaw } = await axios.get(
    `https://animotvslash.p2pplay.pro/api/v1/folder?id=${videoId}`,
    { headers: HEADERS }
  );
  const folderToken = typeof folderRaw === 'string' ? folderRaw.trim() : null;

  const basePath = '/hls/wSPyTPvFL62A4i4GCQTW2g/5c/1xmlfi6v/bkhgbv/tt/master.m3u8';
  const vToken = Math.floor(Date.now() / 1000) + 3600;
  const url = `https://animotvslash.p2pplay.pro${basePath}?v=${vToken}`;

  try {
    await axios.head(url, { headers: HEADERS });
    return url;
  } catch (e) {
    // Try with folder token as v param
    const url2 = `https://animotvslash.p2pplay.pro${basePath}?v=${folderToken}`;
    try {
      await axios.head(url2, { headers: HEADERS });
      return url2;
    } catch (_) {}
  }
  return null;
}

app.get('/proxy/stream', async (req, res) => {
  const streamUrl = req.query.url;
  if (!streamUrl) return res.status(400).send('Missing url');

  try {
    const isM3u8 = streamUrl.includes('.m3u8');
    const response = await axios.get(streamUrl, {
      responseType: isM3u8 ? 'text' : 'stream',
      headers: HEADERS
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (isM3u8) {
      let m3u8 = response.data;
      const base = new URL(streamUrl);
      const vParam = base.searchParams.get('v') || '';

      m3u8 = m3u8.replace(/URI="([^"]+)"/g, (_, uri) => {
        let resolved = uri.startsWith('http') ? uri : new URL(uri.split('?')[0], base).href;
        if (vParam) resolved = resolved.split('?')[0] + '?v=' + vParam;
        return `URI="http://localhost:${PORT}/proxy/stream?url=${encodeURIComponent(resolved)}"`;
      });

      m3u8 = m3u8.replace(/^(?!#)([^\n\r]+)$/gm, (match) => {
        const trimmed = match.trim();
        if (!trimmed) return match;
        let resolved = trimmed.startsWith('http') ? trimmed : new URL(trimmed.split('?')[0], base).href;
        if (vParam) resolved = resolved.split('?')[0] + '?v=' + vParam;
        return `http://localhost:${PORT}/proxy/stream?url=${encodeURIComponent(resolved)}`;
      });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.send(m3u8);
    }

    res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp2t');
    response.data.pipe(res);
  } catch (err) {
    res.status(500).send('Proxy error: ' + err.message);
  }
});

app.get('/episode', async (req, res) => {
  const episodeUrl = req.query.url || 'https://animotvslash.org/one-piece-episode-1/';
  try {
    const { iframeSrc, videoId } = await getVideoId(episodeUrl);
    const m3u8Url = videoId ? await fetchStreamUrl(videoId) : null;
    res.json({
      episodeUrl, iframeSrc, videoId, m3u8Url,
      proxiedStream: m3u8Url ? `http://localhost:${PORT}/proxy/stream?url=${encodeURIComponent(m3u8Url)}` : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/watch', async (req, res) => {
  const episodeUrl = req.query.url || 'https://animotvslash.org/one-piece-episode-1/';
  let data;
  try {
    const resp = await axios.get(`http://localhost:${PORT}/episode?url=${encodeURIComponent(episodeUrl)}`);
    data = resp.data;
  } catch (err) {
    return res.status(500).send('Episode fetch failed: ' + err.message);
  }

  const m3u8 = data.m3u8Url;
  if (!m3u8) return res.status(404).send(`<pre>${JSON.stringify(data, null, 2)}</pre>`);

  const vToken = new URL(m3u8).searchParams.get('v') || '';
  const proxied = `http://localhost:${PORT}/proxy/stream?url=${encodeURIComponent(m3u8)}`;

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Player</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; display: flex; justify-content: center; align-items: center; height: 100vh; }
    video { width: 100%; max-width: 960px; }
  </style>
</head>
<body>
  <video id="v" controls autoplay></video>
  <script>
    const FRESH_V = '${vToken}';
    const BASE = 'http://localhost:${PORT}';

    class TokenLoader extends Hls.DefaultConfig.loader {
      load(context, config, callbacks) {
        let url = context.url;
        if (FRESH_V && url.includes('.m3u8')) {
          url = url.replace(/[?&]v=[^&]+/, '');
          url += (url.includes('?') ? '&' : '?') + 'v=' + FRESH_V;
          if (!url.startsWith(BASE)) {
            url = BASE + '/proxy/stream?url=' + encodeURIComponent(url);
          }
          context.url = url;
        }
        super.load(context, config, callbacks);
      }
    }

    const video = document.getElementById('v');
    const hls = new Hls({ loader: TokenLoader });
    hls.loadSource('${proxied}');
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (e, d) => console.error('HLS error', d.type, d.details, d.url));
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`\nServer at http://localhost:${PORT}`);
  console.log(`  /watch?url=https://animotvslash.org/one-piece-episode-1/`);
  console.log(`  /watch?url=https://animotvslash.org/one-piece-episode-2/\n`);
});