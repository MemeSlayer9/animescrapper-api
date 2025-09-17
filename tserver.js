const express = require('express');
const axios = require('axios');
const { JSDOM } = require('jsdom');
const cors = require('cors');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Configuration
const config = {
  // Rotate between different user agents to avoid detection
  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0'
  ],
  MAX_RETRIES: 5,
  RETRY_DELAY: 2000,
  HLS_PROXY_URL: 'https://hls.shrina.dev/proxy/',
  // Alternative domains if the primary one fails
  ALTERNATIVE_DOMAINS: [
    'masteranime.tv/masterani.me',
    'masterani.me',
    'anime-master.tv',
    'master-anime.cc'
  ],
  // Request timeout in milliseconds
  TIMEOUT: 15000
};

// Get a random user agent
function getRandomUserAgent() {
  const agents = config.USER_AGENTS;
  return agents[Math.floor(Math.random() * agents.length)];
}

// Get active domain - tries each domain until one works
let activeDomain = config.ALTERNATIVE_DOMAINS[0];
let domainCheckInProgress = false;

// Setup basic axios config
function getAxiosConfig() {
  return {
    timeout: config.TIMEOUT,
    httpsAgent: new https.Agent({ 
      rejectUnauthorized: false, // Allow self-signed certs
      keepAlive: true
    })
  };
}

// Helper: Validate domain by checking if it's accessible
async function validateDomain(domain) {
  try {
    const response = await axios.get(`https://${domain}`, {
      ...getAxiosConfig(),
      timeout: 5000,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0'
      }
    });
    return response.status < 400;
  } catch (error) {
    console.log(`Domain ${domain} validation failed:`, error.message);
    return false;
  }
}

// Helper: Check and update the active domain
async function checkAndUpdateDomain() {
  if (domainCheckInProgress) return;
  
  domainCheckInProgress = true;
  
  for (const domain of config.ALTERNATIVE_DOMAINS) {
    const isValid = await validateDomain(domain);
    if (isValid) {
      activeDomain = domain;
      console.log(`Active domain set to: ${activeDomain}`);
      domainCheckInProgress = false;
      return domain;
    }
  }
  
  console.log('All domains failed validation');
  domainCheckInProgress = false;
  return null;
}

// Initial domain check
checkAndUpdateDomain();

// Helper: Apply different retry strategies for different errors
async function fetchWithRetry(url, options, retries = config.MAX_RETRIES) {
  let lastError = null;
  
  for (let i = 0; i < retries; i++) {
    try {
      // Add random user agent on each retry
      if (!options.headers) options.headers = {};
      options.headers['User-Agent'] = getRandomUserAgent();
      
      // Add browser-like headers
      options.headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
      options.headers['Accept-Language'] = 'en-US,en;q=0.5';
      options.headers['Accept-Encoding'] = 'gzip, deflate, br';
      options.headers['Cache-Control'] = 'no-cache';
      options.headers['Pragma'] = 'no-cache';
      
      const response = await axios({
        url,
        ...options,
        ...getAxiosConfig(),
        validateStatus: (status) => status < 500 // Accept 4xx responses
      });
      
      // Handle specific cases even if the request "succeeded"
      if (response.status === 403) {
        console.log('403 Forbidden error, might need to update strategies');
        // Try a different method on the next attempt
        if (options.method === 'GET') options.method = 'HEAD';
        throw new Error('403 Forbidden');
      }
      
      if (response.status === 429) {
        // Too many requests - wait longer
        await new Promise(resolve => setTimeout(resolve, config.RETRY_DELAY * 3));
        throw new Error('429 Too Many Requests');
      }
      
      if (response.status >= 200 && response.status < 300) {
        return response;
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
      console.log(`Retry ${i+1}/${retries} failed for ${url}: ${error.message}`);
      
      // If it's a 403 error and we've tried multiple times, try to find a new domain
      if (error.message.includes('403') && i >= 2 && !domainCheckInProgress) {
        console.log('Multiple 403 errors, checking for new domain...');
        await checkAndUpdateDomain();
        
        // Update URL with new domain if successful
        const urlObj = new URL(url);
        url = url.replace(urlObj.hostname, activeDomain);
      }
      
      // Apply progressive backoff with some randomness
      const delay = config.RETRY_DELAY * (i + 1) * (0.5 + Math.random());
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError || new Error('Max retries reached');
}

// Helper: Extract CTK token from HTML using JSDOM with enhanced detection
async function extractCTK(html) {
  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    
    // Multiple CTK extraction methods
    const ctk = [
      // Meta tag
      doc.querySelector('meta[name="ctk"]')?.content,
      doc.querySelector('meta[property="ctk"]')?.content,
      
      // Input field
      doc.querySelector('input[name="ctk"]')?.value,
      
      // Data attribute
      doc.querySelector('[data-ctk]')?.dataset.ctk,
      
      // From scripts
      ...Array.from(doc.scripts)
        .map(script => {
          const text = script.textContent;
          // Multiple regex patterns to find CTK
          const patterns = [
            /ctk\s*[:=]\s*['"]([a-f0-9]{32})['"]/i,
            /csrf\s*[:=]\s*['"]([a-f0-9]{32})['"]/i,
            /token\s*[:=]\s*['"]([a-f0-9]{32})['"]/i,
            /['"]ctk['"]\s*[:=]\s*['"]([a-f0-9]{32})['"]/i
          ];
          
          return patterns
            .map(pattern => text.match(pattern)?.[1])
            .filter(Boolean)[0];
        })
        .filter(Boolean),
      
      // From the HTML as a whole
      ...Array.from(html.matchAll(/ctk=([a-f0-9]{32})/gi)).map(match => match[1]),
      ...Array.from(html.matchAll(/csrf=([a-f0-9]{32})/gi)).map(match => match[1]),
      ...Array.from(html.matchAll(/token=([a-f0-9]{32})/gi)).map(match => match[1])
    ].filter(Boolean);
    
    return ctk[0] || null;
  } catch (error) {
    console.error('CTK extraction error:', error.message);
    return null;
  }
}

// Helper: Generate proxied HLS URL
function generateProxiedUrl(m3u8Url) {
  const encodedUrl = encodeURIComponent(m3u8Url);
  return `${config.HLS_PROXY_URL}${encodedUrl}`;
}

// Helper: More reliable M3U8 extraction
function extractM3U8Url(html) {
  // Multiple patterns to extract m3u8 URLs
  const patterns = [
    /(https:\/\/[^\s'"]+\.m3u8[^\s'"]*)/i,
    /source\s+src=["']([^"']+\.m3u8[^"']*)/i,
    /file\s*:\s*["']([^"']+\.m3u8[^"']*)/i,
    /url\s*:\s*["']([^"']+\.m3u8[^"']*)/i,
    /hls(?:Source|Url|Path)['"]\s*:\s*["']([^"']+\.m3u8[^"']*)/i
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return match[1];
  }
  
  return null;
}

// Main endpoint to extract M3U8 URL
app.get('/get-m3u8', async (req, res) => {
  let phpsessid = '';
  let debug = { steps: [], errors: [] };

  // Use query parameters to allow custom anime pages
  const slug = req.query.slug || 'detective-conan-sub.57016';
  const episodeId = req.query.episode || '195390';
  
  // Optional flag to decide whether to use the proxy
  const useProxy = req.query.proxy !== 'false';
  
  // Store the base domain for reference
  const baseUrl = `https://${activeDomain}`;
  debug.domain = activeDomain;

  try {
    // Step 1: Acquire initial session
    const sessionRes = await fetchWithRetry(baseUrl, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate'
      }
    });
    
    // Extract cookies, especially PHPSESSID
    const cookies = sessionRes.headers['set-cookie'] || [];
    phpsessid = cookies
      .filter(cookie => cookie.includes('PHPSESSID'))
      .map(cookie => cookie.split(';')[0])
      .join('; ');
      
    if (!phpsessid) {
      // Look for other session cookies if PHPSESSID not found
      phpsessid = cookies
        .filter(cookie => /sess|sid|session/i.test(cookie))
        .map(cookie => cookie.split(';')[0])
        .join('; ');
    }
    
    debug.steps.push('session_acquired');
    
    // Wait a bit to seem more human-like
    await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));

    // Step 2: Load the episode page using the provided slug and episode ID
    const episodeUrl = `${baseUrl}/anime/watch/${slug}/${episodeId}`;
    const episodeRes = await fetchWithRetry(episodeUrl, {
      headers: {
        Cookie: phpsessid,
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': baseUrl,
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin'
      }
    });
    debug.steps.push('episode_page_loaded');

    // Step 3: Extract the CTK token from the episode page HTML
    const ctk = await extractCTK(episodeRes.data);
    if (!ctk) {
      debug.errors.push('CTK extraction failed');
      // Try an alternative approach - look for API URL directly
      const apiUrlMatch = episodeRes.data.match(/ajax\/anime\/([^\s'"]+)/);
      if (!apiUrlMatch) {
        throw new Error('CTK extraction failed and no API URL found');
      }
      debug.steps.push('api_url_extracted_directly');
    } else {
      debug.ctk = ctk;
      debug.steps.push('ctk_extracted');
    }

    // Wait a bit before making the API request
    await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));

    // Step 4: Request the API to get the embed URL using the CTK token
    let apiUrl = `${baseUrl}/ajax/anime/load_episodes_v2?s=tserver`;
    
    // Try direct extraction of the API URL if it failed above
    if (!ctk && episodeRes.data.includes('ajax/anime/')) {
      const apiUrlMatch = episodeRes.data.match(/ajax\/anime\/([^\s'"]+)/);
      if (apiUrlMatch) {
        apiUrl = `${baseUrl}/ajax/anime/${apiUrlMatch[1]}`;
      }
    }
    
    // Prepare the correct payload
    const payload = ctk ? `episode_id=${episodeId}&ctk=${ctk}` : `episode_id=${episodeId}`;
    
    const apiRes = await fetchWithRetry(apiUrl, {
      method: 'POST',
      data: payload,
      headers: {
        Cookie: phpsessid,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': episodeUrl,
        'Origin': baseUrl,
        'User-Agent': getRandomUserAgent()
      }
    });
    debug.steps.push('api_response_received');

    // Step 5: Process API response and extract the embed URL
    let embedUrl = '';
    let apiData = apiRes.data;
    
    // Handle different response formats
    if (typeof apiData === 'string') {
      try {
        apiData = JSON.parse(apiData);
      } catch (e) {
        // Keep as string if parsing fails
      }
    }
    
    if (typeof apiData === 'object' && apiData !== null) {
      // Extract from object - try various properties
      if (apiData.value) {
        const srcMatch = apiData.value.match(/src=["']([^"']+)["']/);
        if (srcMatch) embedUrl = srcMatch[1];
      }
      
      // Loop through all object properties searching for URLs
      if (!embedUrl) {
        for (const key in apiData) {
          if (typeof apiData[key] === 'string') {
            // Look for iframe src
            const srcMatch = apiData[key].match(/src=["']([^"']+)["']/);
            if (srcMatch) {
              embedUrl = srcMatch[1];
              break;
            }
            
            // Look for direct embed URL
            if (apiData[key].includes('embed') || apiData[key].includes('player')) {
              const urlMatch = apiData[key].match(/(https?:\/\/[^\s"']+)/);
              if (urlMatch) {
                embedUrl = urlMatch[0];
                break;
              }
            }
          }
        }
      }
    } else if (typeof apiData === 'string') {
      // Extract from string
      const embedUrlMatch = apiData.match(/src=\\?"(https?:\/\/[^"\\]+)/);
      if (embedUrlMatch) {
        embedUrl = embedUrlMatch[1].replace(/\\\//g, '/');
      }
    }

    // Fallback: Try to find a direct M3U8 URL in the API response
    if (!embedUrl) {
      const m3u8Match = typeof apiRes.data === 'string' 
        ? apiRes.data.match(/(https:\/\/[^\s'"]+\.m3u8[^\s'"]*)/i)
        : null;
        
      if (m3u8Match) {
        debug.steps.push('direct_m3u8_found_in_api');
        const m3u8Url = m3u8Match[0];
        debug.m3u8 = m3u8Url;
        
        // Generate proxied URL if requested
        const proxiedUrl = useProxy ? generateProxiedUrl(m3u8Url) : m3u8Url;
        
        // Return early with the direct M3U8
        return res.json({
          success: true,
          source: 'api_direct',
          m3u8_url: m3u8Url,
          proxied_url: useProxy ? proxiedUrl : null,
          use_proxy: useProxy,
          debug
        });
      }
      
      throw new Error('Unable to extract embed URL');
    }
    
    debug.embedUrl = embedUrl;
    debug.steps.push('embed_url_parsed');

    // Wait a bit before fetching the embed
    await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));

    // Step 6: Fetch the embed page and extract the M3U8 URL
    const embedRes = await fetchWithRetry(embedUrl, {
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Referer': episodeUrl,
        'Accept': '*/*',
        'Origin': baseUrl
      }
    });
    debug.steps.push('embed_page_loaded');

    const m3u8Url = extractM3U8Url(embedRes.data);
    if (!m3u8Url) {
      // Try alternate extraction methods
      const alternatePatterns = [
        /source\s+src=["']([^"']+)["']/i,
        /file\s*:\s*["']([^"']+)["']/i,
        /url\s*:\s*["']([^"']+)["']/i
      ];
      
      for (const pattern of alternatePatterns) {
        const match = embedRes.data.match(pattern);
        if (match && match[1]) {
          debug.steps.push('alternate_extraction_method');
          const url = match[1];
          
          // Check if this is a valid video URL
          if (url.match(/\.(mp4|webm|m3u8|mpd)/i)) {
            debug.m3u8 = url;
            
            // Generate proxied URL if requested
            const proxiedUrl = useProxy ? generateProxiedUrl(url) : url;
            
            return res.json({
              success: true,
              source: 'alternate_method',
              m3u8_url: url,
              proxied_url: useProxy ? proxiedUrl : null,
              use_proxy: useProxy,
              debug
            });
          }
        }
      }
      
      throw new Error('M3U8 URL not found');
    }
    
    debug.m3u8 = m3u8Url;
    debug.steps.push('m3u8_url_found');

    // Step 7: Generate proxied URL if requested
    const proxiedUrl = useProxy ? generateProxiedUrl(m3u8Url) : m3u8Url;
    debug.steps.push(useProxy ? 'proxy_url_generated' : 'using_direct_url');

    // Respond with both the direct and proxied URLs
    res.json({
      success: true,
      source: 'primary_flow',
      m3u8_url: m3u8Url,
      proxied_url: useProxy ? proxiedUrl : null,
      use_proxy: useProxy,
      debug: {
        steps: debug.steps,
        domain: activeDomain,
        phpsessid: phpsessid ? (phpsessid.slice(0, 10) + '...') : 'not_set',
        ctk: ctk ? (ctk.slice(0, 8) + '...') : 'not_extracted'
      }
    });
  } catch (error) {
    console.error(`Error in /get-m3u8:`, error);
    
    // Schedule a domain check on error
    if (error.message.includes('403') || error.message.includes('ECONNREFUSED')) {
      checkAndUpdateDomain().catch(console.error);
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
      domain_status: {
        current: activeDomain,
        checking: domainCheckInProgress
      },
      debug: {
        ...debug,
        errors: [...(debug.errors || []), error.message],
        errorStep: debug.steps[debug.steps.length - 1] || 'unknown',
        phpsessid: phpsessid ? '*****' : 'not_set'
      }
    });
  }
});

// Additional endpoint for direct proxy usage
app.get('/proxy', (req, res) => {
  const url = req.query.url;
  
  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'Missing URL parameter'
    });
  }
  
  // Redirect to the HLS proxy with the encoded URL
  const proxiedUrl = generateProxiedUrl(url);
  res.redirect(proxiedUrl);
});

// Status endpoint
app.get('/status', async (req, res) => {
  // Force domain check if requested
  if (req.query.refresh === 'true') {
    await checkAndUpdateDomain();
  }
  
  res.json({
    status: 'online',
    version: '1.2.0',
    domain: {
      active: activeDomain,
      checking: domainCheckInProgress,
      alternatives: config.ALTERNATIVE_DOMAINS
    },
    proxy: {
      enabled: config.USE_PROXY,
      host: config.USE_PROXY ? (config.PROXY_HOST.slice(0, 5) + '...') : null
    },
    cf_clearance: config.CF_CLEARANCE ? 'configured' : 'not_set'
  });
});

// Root endpoint for testing
app.get('/', (req, res) => {
  res.send(`
    <h1>Anime Stream Server with HLS Proxy</h1>
    <p>Access M3U8 at <a href="/get-m3u8">/get-m3u8</a></p>
    <p>Usage: /get-m3u8?slug=anime-slug&episode=episode-id&proxy=true|false</p>
    <p>Direct proxy: /proxy?url=YOUR_M3U8_URL</p>
    <p>Status: <a href="/status">/status</a></p>
    <h3>Features:</h3>
    <ul>
      <li>403 Error handling with domain fallbacks</li>
      <li>Automatic session management</li>
      <li>Enhanced CTK extraction</li>
      <li>CORS enabled</li>
      <li>Multiple extraction strategies</li>
      <li>Random user agents</li>
      <li>HLS proxy integration</li>
    </ul>
    <div id="result"></div>
    <script>
      // Simple test function
      async function testEndpoint() {
        document.getElementById('result').innerHTML = '<p>Testing API...</p>';
        try {
          const response = await fetch('/get-m3u8');
          const data = await response.json();
          console.log('Response:', data);
          
          let html = '<h3>Test Result:</h3>';
          if (data.success) {
            html += '<p>Status: <span style="color:green">Success</span></p>';
            html += '<p>Direct URL: ' + data.m3u8_url + '</p>';
            if (data.proxied_url) {
              html += '<p>Proxied URL: ' + data.proxied_url + '</p>';
              html += '<button onclick="playVideo(\'' + data.proxied_url + '\')">Test Video</button>';
            }
            html += '<p>Steps: ' + data.debug.steps.join(' → ') + '</p>';
          } else {
            html += '<p>Status: <span style="color:red">Failed</span></p>';
            html += '<p>Error: ' + data.error + '</p>';
            html += '<p>Domain: ' + (data.domain_status?.current || 'unknown') + '</p>';
            html += '<p>Last step: ' + data.debug.errorStep + '</p>';
            html += '<button onclick="checkStatus()">Check Status</button>';
          }
          document.getElementById('result').innerHTML = html;
        } catch (error) {
          document.getElementById('result').innerHTML = '<p>Error: ' + error.message + '</p>';
        }
      }
      
      async function checkStatus() {
        try {
          const response = await fetch('/status?refresh=true');
          const data = await response.json();
          let html = '<h3>Status Check:</h3>';
          html += '<p>Active domain: ' + data.domain.active + '</p>';
          html += '<p>Domain checking: ' + data.domain.checking + '</p>';
          html += '<p>Alternatives: ' + data.domain.alternatives.join(', ') + '</p>';
          document.getElementById('result').innerHTML = html;
        } catch (error) {
          document.getElementById('result').innerHTML = '<p>Status check error: ' + error.message + '</p>';
        }
      }
      
      function playVideo(url) {
        if (url) {
          document.getElementById('result').innerHTML += '<video id="player" controls style="max-width: 100%; margin-top: 20px"></video>';
          
          if (Hls.isSupported()) {
            const video = document.getElementById('player');
            const hls = new Hls();
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, function() {
              video.play();
            });
          }
        }
      }
    </script>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <button onclick="testEndpoint()">Test API</button>
    <button onclick="checkStatus()">Check Status</button>
  `);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Active domain: ${activeDomain}`);
});