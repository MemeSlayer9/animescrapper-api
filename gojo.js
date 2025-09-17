const express = require('express');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const { JSDOM } = require('jsdom');
const { URL } = require('url');

const app = express();
const PORT = 3000;

// Initialize cookie jar properly
 
// Configure axios instance with cookie support
const axiosInstance = axios.create({
  headers: {
    'authority': 'gojo.wtf',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    'dnt': '1',
    'pragma': 'no-cache',
    'referer': 'https://www.google.com/',
    'sec-ch-ua': '"Chromium";v="118", "Google Chrome";v="118", "Not=A?Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
  },
  jar: cookieJar,
  withCredentials: true,
  maxRedirects: 5
});

// Cookie jar for session persistence
const cookieJar = new axios.CookieJar();

 
// Advanced URL pattern matcher
const URL_PATTERNS = [
  // Standard HLS patterns
  /(?:file:|src:|url:)\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi,
  /(?:hls|playlist)Url["']?:\s*["'](.*?\.m3u8.*?)["']/gi,
  
  // Encoded patterns
  /(?:\\x2F|%2F)([a-zA-Z0-9_\-/]+\.m3u8\??[a-zA-Z0-9_\-&%=]*)/gi, 
  /(?:\\u002F)(.+?\.m3u8)/gi,
  
  // Split URL patterns
  /(?:['"])(https?:?\/\/(?:[^"'\\]|\\.)+?\.m3u8)/gi,
  /(?:['"])(\/[^"'\\]+\/playlist\.m3u8)/gi,
  
  // JSON embedded patterns
  /"url"\s*:\s*"([^"]+\.m3u8[^"]*)"/gi,
  /"playlist_url"\s*:\s*"([^"]+\.m3u8[^"]*)"/gi
];

function extractM3U8Url(content, baseUrl) {
  // Normalize content
  const decodedContent = content
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/');

  // Multi-stage extraction
  for (const pattern of URL_PATTERNS) {
    const matches = [...decodedContent.matchAll(pattern)];
    for (const [_, url] of matches) {
      try {
        const cleanedUrl = url
          .replace(/^["']+|["']+$/g, '')
          .replace(/\\+/g, '');
        
        const finalUrl = new URL(cleanedUrl, baseUrl).href;
        if (finalUrl.includes('.m3u8')) return finalUrl;
      } catch (e) {
        continue;
      }
    }
  }

  // Fallback: DOM-based extraction
  const dom = new JSDOM(decodedContent);
  const elements = dom.window.document.querySelectorAll('[src*="m3u8"], [data-src*="m3u8"]');
  for (const element of elements) {
    const src = element.src || element.getAttribute('data-src');
    if (src) {
      try {
        return new URL(src, baseUrl).href;
      } catch (e) {
        continue;
      }
    }
  }

  return null;
}

async function fetchStreamUrl(watchUrl) {
  try {
    // Initial request with full browser emulation
    const response = await axiosInstance.get(watchUrl, {
      validateStatus: (status) => status >= 200 && status < 400
    });

    const html = response.data;
    const baseUrl = new URL(watchUrl).origin;

    // First extraction attempt
    let m3u8Url = extractM3U8Url(html, baseUrl);

    // Second attempt: Script concatenation
    if (!m3u8Url) {
      const $ = cheerio.load(html);
      let scriptContent = '';
      $('script').each((i, el) => {
        scriptContent += $(el).html() + ' ';
      });
      m3u8Url = extractM3U8Url(scriptContent, baseUrl);
    }

    // Third attempt: Iframe source check
    if (!m3u8Url) {
      const $ = cheerio.load(html);
      const iframeSrc = $('iframe').attr('src');
      if (iframeSrc) {
        const iframeUrl = new URL(iframeSrc, baseUrl).href;
        const iframeResponse = await axiosInstance.get(iframeUrl);
        m3u8Url = extractM3U8Url(iframeResponse.data, iframeUrl);
      }
    }

    if (!m3u8Url) throw new Error('M3U8 URL not found');
    return m3u8Url;
  } catch (error) {
    throw new Error(`Failed to extract stream: ${error.message}`);
  }
}

app.get('/scrape', async (req, res) => {
  try {
    const watchUrl = 'https://gojo.wtf/watch/185736?ep=1&provider=zaza&subType=sub';
    const m3u8Url = await fetchStreamUrl(watchUrl);
    
    // Validate and fetch final playlist
    const m3u8Response = await axiosInstance.get(m3u8Url);
    res.type('application/vnd.apple.mpegurl').send(m3u8Response.data);
  } catch (error) {
    res.status(500).json({
      error: error.message,
      possibleReasons: [
        'Cloudflare protection triggered',
        'Session cookies invalidated',
        'Dynamic URL generation not handled',
        'Anti-bot measures detected'
      ]
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Request headers configured:');
  console.dir(headers, { depth: null });
});