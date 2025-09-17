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
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
  MAX_RETRIES: 3
};

async function fetchWithRetry(url, options, retries = config.MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios({ url, ...options });
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
    }
  }
}

async function extractCTK(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  return [
    doc.querySelector('meta[name="ctk"]')?.content,
    doc.querySelector('input[name="ctk"]')?.value,
    ...Array.from(doc.scripts)
      .map(script => script.textContent.match(/ctk\s*[:=]\s*['"]([a-f0-9]{32})/)?.[1]),
    doc.querySelector('[data-ctk]')?.dataset.ctk,
    ...Array.from(html.matchAll(/ctk=([a-f0-9]{32})/gi)).map(match => match[1])
  ].flat().find(Boolean);
}

async function extractM3U8FromEmbed(embedUrl) {
  const { data } = await axios.get(embedUrl, {
    headers: {
      'User-Agent': config.USER_AGENT,
      Referer: 'https://masteranime.tv/'
    }
  });

  // First try: Direct regex match from static HTML
  const staticMatch = data.match(/(https:\/\/s\d+\.openstream\.io\/hls\/[^'"]+\.m3u8)/);
  if (staticMatch) return staticMatch[0];

  // Second try: Use JSDOM with injected stubs to avoid errors
  const dom = new JSDOM(data, { 
    runScripts: 'dangerously', 
    resources: 'usable',
    beforeParse(window) {
      // Polyfill for performance.timing
      if (!window.performance) {
        window.performance = {};
      }
      if (!window.performance.timing) {
        window.performance.timing = { navigationStart: Date.now() };
      }
      // Enhanced stub for jwplayer to avoid errors
      if (!window.jwplayer) {
        window.jwplayer = function() {
          return {
            getPosition: () => 0,
            setup: () => {},
            on: () => {},
            play: () => {},
            pause: () => {}
          };
        };
      }
      // Stub for a global playerInstance if created
      window.playerInstance = {
        getPosition: () => 0,
        setup: () => {},
        on: () => {},
        play: () => {},
        pause: () => {}
      };
    }
  });
  
  // Wait for scripts to execute (adjust delay if needed)
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Try to find the m3u8 URL in the updated DOM content
  const dynamicMatch = dom.serialize().match(/(https:\/\/s\d+\.openstream\.io\/hls\/[^'"]+\.m3u8)/);
  if (dynamicMatch) return dynamicMatch[0];

  // Final attempt: Search within the concatenated script content
  const scriptContent = Array.from(dom.window.document.scripts)
    .map(script => script.textContent)
    .join('\n');

  const jsMatch = scriptContent.match(/(https:\\?\/\\?\/s\d+\.openstream\.io\\?\/hls\\?\/[^'"]+\.m3u8)/);
  if (jsMatch) return jsMatch[0].replace(/\\/g, '');

  throw new Error('M3U8 URL not found in embed page');
}

app.get('/get-m3u8', async (req, res) => {
  const debug = { steps: [] };
  const { slug } = req.query;
  
  if (!slug) {
    return res.status(400).json({ success: false, error: 'Missing slug parameter. Expected format: animeSlug/episode' });
  }
  
  // Expecting slug in the format "animeSlug/episode"
  const parts = slug.split('/');
  if (parts.length < 2) {
    return res.status(400).json({ success: false, error: 'Invalid slug format. Expected format: animeSlug/episode' });
  }
  
  const [animeSlug, episode] = parts;
  const episodeUrl = `https://masteranime.tv/anime/watch/${animeSlug}/${episode}`;
  debug.episodeUrl = episodeUrl;
  
  try {
    // Step 1: Get initial session
    const sessionRes = await fetchWithRetry('https://masteranime.tv', { 
      headers: { 'User-Agent': config.USER_AGENT } 
    });
    const phpsessid = sessionRes.headers['set-cookie']?.[0]?.split(';')[0] || '';
    debug.steps.push('session_acquired');

    // Step 2: Load episode page
    const episodeRes = await fetchWithRetry(episodeUrl, {
      headers: { Cookie: phpsessid, 'User-Agent': config.USER_AGENT }
    });
    debug.steps.push('episode_page_loaded');

    // Step 3: Extract CTK
    const ctk = await extractCTK(episodeRes.data);
    if (!ctk) throw new Error('CTK extraction failed');
    debug.ctk = ctk;
    debug.steps.push('ctk_extracted');

    // Step 4: Get embed URL from oserver
    const apiRes = await axios.post(
      'https://masteranime.tv/ajax/anime/load_episodes_v2?s=oserver',
      qs.stringify({ episode_id: episode, ctk }),
      {
        headers: {
          Cookie: phpsessid,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest'
        }
      }
    );
    debug.steps.push('oserver_response_received');
    console.log('API response:', apiRes.data); // Logging API response for debugging
    
    // Step 5: Parse embed URL from API response using the value property
    let apiData = apiRes.data;
    if (typeof apiData === 'string') {
      try {
        apiData = JSON.parse(apiData);
      } catch (e) {
        throw new Error('Invalid API response format');
      }
    }
    
    const embedPath = apiData.value;
    if (!embedPath) throw new Error('Embed path not found');
    
    const embedUrlMatch = embedPath.match(/src=["']([^"']+)["']/);
    if (!embedUrlMatch) throw new Error('Embed URL not found in the embed path');
    const embedUrl = embedUrlMatch[1];
    debug.embedUrl = embedUrl;
    debug.steps.push('embed_url_parsed');

    // Step 6: Extract M3U8 from embed page
    const m3u8Url = await extractM3U8FromEmbed(embedUrl);
    debug.m3u8_url = m3u8Url;
    debug.steps.push('m3u8_extracted');

    // Step 7: Verify M3U8 availability
    const m3u8Res = await axios.get(m3u8Url, {
      headers: {
        'User-Agent': config.USER_AGENT,
        Referer: embedUrl,
        Origin: new URL(embedUrl).origin
      }
    });
    
    res.json({
      success: true,
      m3u8_url: m3u8Url,
      m3u8_content: m3u8Res.data,
      debug
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      debug
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
