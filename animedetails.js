const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { setTimeout } = require('timers/promises');

const app = express();
const port = process.env.PORT || 3000;

// Enable JSON body parsing
app.use(express.json());

// Configure proxy settings
const PROXY_OPTIONS = {
  // Primary proxy
  primary: 'https://hls.ciphertv.dev/proxy/',
  // Backup proxies (implement your own)
  backups: [
    // Add alternative proxy URLs here
    // 'https://backup-proxy.example.com/',
    // 'https://cors-anywhere.herokuapp.com/'
  ],
  // Configure if we should rotate between proxies
  rotateProxies: false
};

// Configure request parameters
const REQUEST_CONFIG = {
  // Randomize user agent on each request
  randomizeUserAgent: true,
  // Add random delay between requests (ms)
  minDelay: 500,
  maxDelay: 2000,
  // Retry settings
  maxRetries: 3,
  retryDelay: 2000,
  // Request timeout in milliseconds
  timeout: 15000
};

// User agent list for rotation
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1'
];

// Function to get a random user agent
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Function to get random delay time
function getRandomDelay() {
  return Math.floor(Math.random() * (REQUEST_CONFIG.maxDelay - REQUEST_CONFIG.minDelay + 1)) + REQUEST_CONFIG.minDelay;
}

// Function to get next proxy URL
let currentProxyIndex = 0;
function getProxyUrl() {
  if (!PROXY_OPTIONS.rotateProxies || PROXY_OPTIONS.backups.length === 0) {
    return PROXY_OPTIONS.primary;
  }
  
  const allProxies = [PROXY_OPTIONS.primary, ...PROXY_OPTIONS.backups];
  const proxy = allProxies[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % allProxies.length;
  return proxy;
}

// Function to perform retryable request
async function fetchWithRetry(url, options = {}, retryCount = 0) {
  try {
    // Add random delay before request
    if (retryCount > 0) {
      await setTimeout(REQUEST_CONFIG.retryDelay * retryCount);
    } else if (REQUEST_CONFIG.minDelay > 0) {
      await setTimeout(getRandomDelay());
    }
    
    // Set up headers with user agent
    const headers = {
      'User-Agent': REQUEST_CONFIG.randomizeUserAgent ? getRandomUserAgent() : USER_AGENTS[0],
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0',
      'Referer': 'https://masteranime.tv/',
      ...options.headers
    };
    
    // Use rotation of proxies if enabled
    const proxyBase = getProxyUrl();
    const proxyUrl = `${proxyBase}${encodeURIComponent(url)}`;
    
    console.log(`Request attempt ${retryCount + 1}/${REQUEST_CONFIG.maxRetries + 1} to: ${proxyUrl}`);
    
    const response = await axios.get(proxyUrl, { 
      headers,
      timeout: REQUEST_CONFIG.timeout,
      ...options,
      headers // Ensure headers override any in options
    });
    
    return response;
  } catch (error) {
    // Handle retry logic
    if (retryCount < REQUEST_CONFIG.maxRetries) {
      console.log(`Request failed (${error.message}). Retrying ${retryCount + 1}/${REQUEST_CONFIG.maxRetries}...`);
      return fetchWithRetry(url, options, retryCount + 1);
    }
    
    // If we've exhausted retries, throw the error
    throw error;
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    config: {
      proxy: {
        primary: PROXY_OPTIONS.primary,
        backupCount: PROXY_OPTIONS.backups.length,
        rotation: PROXY_OPTIONS.rotateProxies
      },
      request: {
        userAgentCount: USER_AGENTS.length,
        randomUA: REQUEST_CONFIG.randomizeUserAgent,
        retries: REQUEST_CONFIG.maxRetries,
        timeout: REQUEST_CONFIG.timeout
      }
    }
  });
});

// Test proxy endpoint
app.get('/test-proxy', async (req, res) => {
  try {
    const testUrl = 'https://httpbin.org/get';
    
    console.log(`Testing proxy with URL: ${testUrl}`);
    
    const response = await fetchWithRetry(testUrl);
    
    res.json({
      success: true,
      proxyWorking: true,
      statusCode: response.status,
      data: response.data,
      proxyUsed: getProxyUrl()
    });
  } catch (error) {
    console.error('Proxy test failed:', error.message);
    
    let errorResponse = {
      success: false,
      proxyWorking: false,
      error: error.message,
      proxyUsed: getProxyUrl()
    };
    
    if (error.response) {
      errorResponse.statusCode = error.response.status;
      errorResponse.data = error.response.data;
    }
    
    res.status(500).json(errorResponse);
  }
});

// Route: /details/:id
app.get('/details/:id', async (req, res) => {
  try {
    // Use the id from the URL parameter
    const id = req.params.id;
    
    // Original URL
    const originalUrl = `https://masteranime.tv/anime/info/${id}`;
    
    console.log(`Fetching data for anime ID: ${id}`);
    console.log(`Original URL: ${originalUrl}`);
    
    const { data: html } = await fetchWithRetry(originalUrl);
    const $ = cheerio.load(html);

    // --- Scrape the head section ---
    const headEl = $('#head');
    let headBackground = null,
      headTitle = null,
      headSynonyms = null,
      headGenres = [];
    
    if (headEl.length) {
      const styleAttr = headEl.attr('style') || '';
      const bgMatch = styleAttr.match(/background-image:\s*url\(([^)]+)\)/);
      headBackground = bgMatch ? bgMatch[1] : null;

      const h1El = headEl.find('h1').first();
      headTitle = h1El.clone().children('a, small').remove().end().text().trim();
      headSynonyms = h1El.find('small').text().trim();

      headEl.find('.ui.tag.horizontal.list a.item').each((i, el) => {
        const genre = $(el).text().trim();
        if (genre) headGenres.push(genre);
      });
    } else {
      console.log('Warning: No #head element found');
    }

    // --- Scrape the details section ---
    const detailsEl = $('#details');
    let detailsCover = null;
    if (detailsEl.length) {
      const coverImageEl = detailsEl.find('.cover img');
      if (coverImageEl.length) {
        detailsCover = {
          src: coverImageEl.attr('src') || null,
          alt: coverImageEl.attr('alt') || null
        };
      } else {
        console.log('Warning: No cover image found');
      }
    } else {
      console.log('Warning: No #details element found');
    }

    // --- Scrape the episodes ---
    let episodes = [];
    $('.ui.four.thumbnails .thumbnail.blur').each((i, el) => {
      const episodeAnchor = $(el).find('a.title');
      const episodeUrl = episodeAnchor.attr('href') || '';
      const episodeText = episodeAnchor.find('.limit').text().trim() || '';
      let episodeId = null;
      if (episodeUrl) {
        const parts = episodeUrl.split('/anime/watch/');
        if (parts.length > 1) {
          episodeId = parts[1];
        }
      }
      episodes.push({ episodeId, episodeUrl, episodeText });
    });

    if (episodes.length === 0) {
      console.log('Warning: No episodes found');
    }

    // --- Scrape the description ---
    let description = '';
    $('p').each((i, el) => {
      const paraText = $(el).text().trim();
      if (paraText.length > 50) {  // adjust threshold if needed
        description = $(el).html().trim();
        return false; // break out of the loop once found
      }
    });

    if (!description) {
      console.log('Warning: No description found');
    }

    const result = {
      id,
      headBackground,
      headTitle,
      headSynonyms,
      headGenres,
      detailsCover,
      description,
      episodes,
      success: true,
      scrapedAt: new Date().toISOString()
    };

    console.log(`Successfully scraped data for ID: ${id}`);
    res.json(result);
  } catch (error) {
    console.error('Error fetching anime details:', error.message);
    
    // Check if it's a status code error
    if (error.response) {
      const statusCode = error.response.status;
      console.error(`HTTP Error: ${statusCode}`);
      
      if (statusCode === 403) {
        res.status(403).json({ 
          error: "Access forbidden. The website or proxy may be blocking requests.",
          originalError: error.message,
          suggestions: [
            "Check if the proxy URL is correct and functioning",
            "Try a different proxy service",
            "Implement request throttling",
            "Check if the website has changed or if it offers an official API"
          ],
          proxyUsed: getProxyUrl()
        });
      } else if (statusCode === 404) {
        res.status(404).json({ 
          error: "Anime not found. The ID may be invalid or the content has been removed.",
          proxyUsed: getProxyUrl()
        });
      } else {
        res.status(statusCode).json({ 
          error: `Request failed with status code ${statusCode}`,
          message: error.message,
          proxyUsed: getProxyUrl()
        });
      }
    } else if (error.request) {
      // Request was made but no response received
      console.error('No response received:', error.request);
      res.status(500).json({ 
        error: "No response received from the server. The site or proxy may be down.", 
        message: error.message,
        proxyUsed: getProxyUrl()
      });
    } else {
      // Something else went wrong
      res.status(500).json({ 
        error: "Error processing request", 
        message: error.message,
        proxyUsed: getProxyUrl()
      });
    }
  }
});

// Add a new endpoint to test direct access without proxy
app.get('/test-direct/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const directUrl = `https://masteranime.tv/anime/info/${id}`;
    
    console.log(`Testing direct access to: ${directUrl}`);
    
    const response = await axios.get(directUrl, {
      timeout: REQUEST_CONFIG.timeout,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    });
    
    res.json({
      success: true,
      statusCode: response.status,
      contentType: response.headers['content-type'],
      dataLength: response.data.length,
      dataPreview: response.data.substring(0, 200) + '...'
    });
  } catch (error) {
    let errorResponse = {
      success: false,
      error: error.message
    };
    
    if (error.response) {
      errorResponse.statusCode = error.response.status;
      errorResponse.headers = error.response.headers;
    }
    
    res.status(500).json(errorResponse);
  }
});

// Add middleware to handle errors
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`Test proxy at http://localhost:${port}/test-proxy`);
  console.log(`Health check at http://localhost:${port}/health`);
  console.log(`Direct test at http://localhost:${port}/test-direct/{id}`);
});

// Add a graceful shutdown handler
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});