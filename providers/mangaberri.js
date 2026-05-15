const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const router = express.Router();

/**
 * Root route — JSON API info
 * Example: GET /api
 */
router.get('/', (req, res) => {
  res.json({
    provider: 'Mangaberri',
    version: '1.0.0',
    baseUrl: 'https://mangaberri.com/',
    endpoints: [
      {
        method: 'GET',
        path: '/api/scrape/chapter/:chapterId',
        description: 'Scrape all image pages for a given manga chapter.',
        example: '/manga/mangaberri/scrape/chapter/8584'
      },
      {
        method: 'GET',
        path: '/api/proxy/image?url=IMAGE_URL',
        description: 'Proxy manga images to bypass CORS.',
        example: '/api/proxy/image?url=https://mangaberri.com/path/to/image.jpg'
      },
      {
        method: 'POST',
        path: '/api/scrape',
        description: 'Scrape any given manga page by sending { "url": "..." } in the request body.'
      },
      {
        method: 'GET',
        path: '/api/health',
        description: 'Check if the API server is running.'
      }
    ]
  });
});

// Scrape manga chapter
router.get('/scrape/chapter/:chapterId', async (req, res) => {
  try {
    const { chapterId } = req.params;
    const url = `https://mangaberri.com/tougen-anki/${chapterId}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://mangaberri.com/'
      }
    });

    const $ = cheerio.load(response.data);
    const images = [];
    
    $('img[loading="lazy"]').each((i, elem) => {
      const src = $(elem).attr('src');
      const alt = $(elem).attr('alt');
      const title = $(elem).attr('title');
      
      if (src && src.includes('mangas/')) {
        images.push({
          index: i,
          src,
          alt: alt || '',
          title: title || ''
        });
      }
    });

    res.json({
      success: true,
      chapterId,
      url,
      imageCount: images.length,
      images
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Proxy endpoint to fetch images
router.get('/proxy/image', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://mangaberri.com/'
      }
    });

    const contentType = response.headers['content-type'];
    res.set('Content-Type', contentType);
    res.send(response.data);

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// General manga page scraper
router.post('/scrape', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required in request body' });
    }

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://mangaberri.com/'
      }
    });

    const $ = cheerio.load(response.data);
    const images = [];
    
    $('img').each((i, elem) => {
      const src = $(elem).attr('src');
      if (src) {
        images.push({
          index: i,
          src,
          alt: $(elem).attr('alt') || '',
          title: $(elem).attr('title') || ''
        });
      }
    });

    res.json({
      success: true,
      url,
      imageCount: images.length,
      images
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Manga scraper API is running' });
});

module.exports = router;
