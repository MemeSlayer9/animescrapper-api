const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Scrape manga chapter images
app.get('/api/scrape', async (req, res) => {
  try {
    const url = req.query.url || 'https://www.mangaread.org/manga/one-piece/chapter-1164/';
    
    // Fetch the page
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    // Load HTML into cheerio
    const $ = cheerio.load(response.data);
    
    // Extract manga images
    const images = [];
    $('.wp-manga-chapter-img').each((index, element) => {
      const imgSrc = $(element).attr('src')?.trim() || $(element).attr('data-src')?.trim();
      if (imgSrc) {
        images.push({
          index: index + 1,
          url: imgSrc,
          alt: $(element).attr('alt') || `Page ${index + 1}`
        });
      }
    });

    // Extract chapter info
    const chapterTitle = $('h1').first().text().trim();
    
    res.json({
      success: true,
      url: url,
      chapterTitle: chapterTitle || 'Chapter',
      totalImages: images.length,
      images: images
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to scrape the manga page'
    });
  }
});

// Get specific image with proxy to handle CORS
app.get('/api/image-proxy', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    
    if (!imageUrl) {
      return res.status(400).json({ error: 'Image URL is required' });
    }

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.mangaread.org/'
      }
    });

    const contentType = response.headers['content-type'];
    res.set('Content-Type', contentType);
    res.send(response.data);

  } catch (error) {
    console.error('Image proxy error:', error.message);
    res.status(500).json({ error: 'Failed to fetch image' });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Manga Scraper API',
    endpoints: {
      scrape: '/api/scrape?url=<manga-chapter-url>',
      imageProxy: '/api/image-proxy?url=<image-url>'
    },
    example: `/api/scrape?url=https://www.mangaread.org/manga/one-piece/chapter-1164/`
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Manga scraper server running on http://localhost:${PORT}`);
  console.log(`📖 Try: http://localhost:${PORT}/api/scrape?url=https://www.mangaread.org/manga/one-piece/chapter-1164/`);
});