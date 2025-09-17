const express = require('express');
const axios = require('axios');
const { JSDOM } = require('jsdom');
const cors = require('cors');
const qs = require('querystring');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

const config = {
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  MAX_RETRIES: 5,
  SCRIPT_WAIT: 8000,
  PATTERN_RETRIES: 3,
  HEADERS: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br'
  }
};

async function fetchWithRetry(url, options = {}, retries = config.MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios({
        url,
        ...options,
        headers: {
          'User-Agent': config.USER_AGENT,
          ...options.headers
        },
        maxRedirects: 5,
        validateStatus: () => true
      });

      if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 2500 * (i + 1)));
    }
  }
}

async function extractCTK(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  
  const extractionMethods = [
    () => doc.querySelector('meta[name="ctk"]')?.content,
    () => doc.querySelector('input[name="ctk"]')?.value,
    () => {
      const scriptContent = Array.from(doc.querySelectorAll('script'))
        .map(s => s.textContent)
        .join('\n');
      return scriptContent.match(/ctk\s*[:=]\s*['"]([a-f0-9]{32})/)?.[1];
    },
    () => doc.querySelector('[data-ctk]')?.dataset.ctk,
    () => {
      const urlParams = new URLSearchParams(html.match(/<form[^>]+action="[^"]+\?(.*?)"/)?.[1] || '');
      return urlParams.get('ctk');
    }
  ];

  for (const method of extractionMethods) {
    try {
      const result = method();
      if (result?.match(/^[a-f0-9]{32}$/i)) return result;
    } catch (e) {}
  }
  throw new Error('CTK extraction failed');
}

async function resolveFinalUrl(url) {
  try {
    const response = await axios.head(url, {
      headers: { 'User-Agent': config.USER_AGENT },
      maxRedirects: 5
    });
    return response.request.res.responseUrl;
  } catch (error) {
    return url;
  }
}

async function extractM3U8FromEmbed(embedUrl) {
  const response = await fetchWithRetry(embedUrl, {
    headers: {
      Referer: 'https://masteranime.tv/',
      ...config.HEADERS
    }
  });

  // Check for direct M3U8 in final URL
  const finalUrl = response.request.res.responseUrl;
  if (finalUrl.match(/\.m3u8($|\?)/i)) {
    return await resolveFinalUrl(finalUrl);
  }

  // Check for M3U8 in content
  const contentType = response.headers['content-type'] || '';
  if (contentType.includes('application/vnd.apple.mpegurl')) {
    return await resolveFinalUrl(finalUrl);
  }

  // Fallback to DOM processing
  const dom = new JSDOM(response.data, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    beforeParse(window) {
      window.performance = {
        timing: {
          navigationStart: Date.now(),
          loadEventEnd: Date.now() + 1500
        },
        getEntries: () => [],
        mark: () => {},
        measure: () => {}
      };

      window.navigator = {
        userAgent: config.USER_AGENT,
        plugins: [{ name: 'Chrome PDF Viewer' }],
        hardwareConcurrency: 4,
        webdriver: false
      };

      window.HTMLMediaElement.prototype.play = function() {
        this.dispatchEvent(new window.Event('play'));
        return Promise.resolve();
      };

      let playerState = 'paused';
      window.jwplayer = () => ({
        setup: (config) => {
          window._playerSources = config.sources;
          return {
            on: (event, cb) => {
              if (event === 'ready') setTimeout(cb, 300);
              if (event === 'playAttempt') setTimeout(() => {
                playerState = 'playing';
                cb();
              }, 700);
            },
            play: () => playerState = 'playing',
            pause: () => playerState = 'paused',
            getState: () => playerState
          };
        }
      });

      window.console = {
        log: (...args) => {
          const message = args.join(' ');
          if (message.includes('m3u8')) {
            window._consoleHls = message.match(/https?:\/\/[^\s]+\.m3u8/)?.[0];
          }
        },
        error: () => {},
        warn: () => {}
      };
    }
  });

  await new Promise(resolve => {
    dom.window.addEventListener('load', resolve);
    setTimeout(resolve, config.SCRIPT_WAIT);
  });

  const detectionStrategies = [
    () => dom.window._consoleHls,
    () => dom.window._playerSources?.[0]?.file,
    () => dom.window.document.querySelector('video')?.src,
    () => {
      const scripts = dom.window.document.querySelectorAll('script');
      for (const script of scripts) {
        const content = script.innerHTML
          .replace(/\\x([a-f0-9]{2})/gi, (_, hex) => 
            String.fromCharCode(parseInt(hex, 16)))
          .replace(/\\u([a-f0-9]{4})/gi, (_, hex) => 
            String.fromCharCode(parseInt(hex, 16)));

        const patterns = [
          /(?:src|url)\(["']?(https?:\/\/[^"')]+\.m3u8)/i,
          /(?:hls\.loadSource|player\.updateSrc)\(["']([^"']+)/i,
          /(?:var|let|const)\s+[^=]+=\s*["']((?:https?%3A%2F%2F|https?:\\?\/\\?\/)[^"']+)/i
        ];

        for (const pattern of patterns) {
          const match = content.match(pattern);
          if (match) return match[1].replace(/\\\//g, '/');
        }
      }
      return null;
    }
  ];

  for (const strategy of detectionStrategies) {
    try {
      const result = strategy();
      if (result) return await resolveFinalUrl(result);
    } catch (e) {}
  }

  const combinedSource = [
    response.data,
    ...Array.from(dom.window.document.scripts)
      .map(s => s.innerHTML)
  ].join('\n');

  const patterns = [
    /(?:["'])((?:https?:\\?\/\\?\/[^"']+\.m3u8[^"']*))/i,
    /((?:https?%3A%2F%2F|\\u002F)[^\s"']+\.m3u8)/i,
    /(?:file:|sources:\s*\[\s*{[\s\S]*?url:\s*["'])([^"']+\.m3u8)/i
  ];

  for (const pattern of patterns) {
    const matches = combinedSource.match(pattern);
    if (matches && matches[1]) {
      const url = matches[1]
        .replace(/\\+/g, '')
        .replace(/%3A/gi, ':')
        .replace(/%2F/gi, '/')
        .replace(/\\u002F/g, '/');

      if (url.match(/^https?:\/\/[^\s]+\.m3u8($|\?)/i)) {
        return await resolveFinalUrl(url);
      }
    }
  }

  throw new Error('M3U8 extraction failed after exhaustive detection');
}

app.get('/get-m3u8/:server/:animeSlug/:episode', async (req, res) => {
  const { server, animeSlug, episode } = req.params;
  const debug = { steps: [], timings: { start: Date.now() } };

  try {
    const sessionRes = await fetchWithRetry('https://masteranime.tv', {
      headers: config.HEADERS
    });
    const cookies = sessionRes.headers['set-cookie'] || [];
    const phpsessid = cookies.find(c => c.startsWith('PHPSESSID'))?.split(';')[0] || '';
    debug.steps.push('session_initialized');

    const episodeUrl = `https://masteranime.tv/anime/watch/${animeSlug}/${episode}`;
    const episodeRes = await fetchWithRetry(episodeUrl, {
      headers: { Cookie: phpsessid }
    });
    debug.steps.push('episode_loaded');

    const ctk = await extractCTK(episodeRes.data);
    debug.steps.push('ctk_extracted');

    const apiRes = await axios.post(
      `https://masteranime.tv/ajax/anime/load_episodes_v2?s=${server}`,
      qs.stringify({ episode_id: episode, ctk }),
      {
        headers: {
          Cookie: phpsessid,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest'
        }
      }
    );
    debug.steps.push('api_response_received');

    const embedHtml = apiRes.data?.value || '';
    const embedUrlMatch = embedHtml.match(/src=["'](https?:\/\/[^"']+)["']/);
    if (!embedUrlMatch) throw new Error('Embed URL not found');
    const embedUrl = embedUrlMatch[1];
    debug.steps.push('embed_url_parsed');

    const m3u8Url = await extractM3U8FromEmbed(embedUrl);
    debug.steps.push('m3u8_found');

    await axios.head(m3u8Url, {
      headers: {
        Referer: embedUrl,
        'User-Agent': config.USER_AGENT
      },
      timeout: 10000
    });
    debug.steps.push('url_validated');

    res.json({
      success: true,
      m3u8_url: m3u8Url,
      debug: {
        steps: debug.steps,
        duration: Date.now() - debug.timings.start
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      debug: {
        steps: debug.steps,
        duration: Date.now() - debug.timings.start,
        last_step: debug.steps[debug.steps.length - 1] || 'init'
      }
    });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});