const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
const PORT = 3000;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Scrape manga chapter
app.get('/api/scrape/chapter/:chapterId', async (req, res) => {
  try {
    const { chapterId } = req.params;
    const url = `https://mangaberri.com/tougen-anki/${chapterId}`;
    
    // Fetch the page
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://mangaberri.com/'
      }
    });

    // Parse HTML
    const $ = cheerio.load(response.data);
    const images = [];
    
    // Find all manga page images
    $('img[loading="lazy"]').each((i, elem) => {
      const src = $(elem).attr('src');
      const alt = $(elem).attr('alt');
      const title = $(elem).attr('title');
      
      if (src && src.includes('mangas/')) {
        images.push({
          index: i,
          src: src,
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

// Proxy endpoint to fetch images (to avoid CORS issues on frontend)
app.get('/api/proxy/image', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://mangaberri.com/'
      }
    });

    // Set appropriate content type
    const contentType = response.headers['content-type'];
    res.set('Content-Type', contentType);
    res.send(response.data);

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// General manga page scraper
app.post('/api/scrape', async (req, res) => {
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL is required in request body' });
    }

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
          src: src,
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Manga scraper API is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Try: http://localhost:${PORT}/api/scrape/chapter/8584`);
});