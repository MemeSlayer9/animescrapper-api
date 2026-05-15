const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Custom proxy middleware for bypassing restrictions
app.get('/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://ww2.mangafreak.me/',
        'Origin': 'https://ww2.mangafreak.me'
      },
      maxRedirects: 5,
      timeout: 30000
    });

    // Set appropriate headers
    const contentType = response.headers['content-type'] || 'application/octet-stream';
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });

    res.send(response.data);

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ 
      error: 'Failed to proxy request',
      details: error.message 
    });
  }
});

// Scrape manga chapter images
app.get('/api/scrape-chapter', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Use our custom proxy
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://ww2.mangafreak.me/',
        'Origin': 'https://ww2.mangafreak.me'
      },
      timeout: 30000
    });

    // Load HTML into cheerio
    const $ = cheerio.load(response.data);
    
    // Get the host from the request to build dynamic proxy URLs
    const protocol = req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;
    
    // Extract all manga page images
    const images = [];
    $('img[id="gohere"]').each((i, elem) => {
      let src = $(elem).attr('src');
      const alt = $(elem).attr('alt');
      const width = $(elem).attr('width');
      const height = $(elem).attr('height');
      
      if (src) {
        // Use our custom proxy for images with dynamic domain
        const proxiedSrc = `${baseUrl}/proxy?url=${encodeURIComponent(src)}`;
        
        images.push({
          originalSrc: src,
          src: proxiedSrc,
          alt: alt || '',
          width: width || '',
          height: height || '',
          pageNumber: i + 1
        });
      }
    });

    // Get chapter info
    const title = $('title').text();
    
    res.json({
      success: true,
      chapterTitle: title,
      totalPages: images.length,
      images
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to scrape manga chapter',
      details: error.message
    });
  }
});

// Get specific manga chapter by series, chapter number
app.get('/api/manga/:series/:chapter', async (req, res) => {
  try {
    const { series, chapter } = req.params;
    const url = `https://ww2.mangafreak.me/Read1_${series}_${chapter}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://ww2.mangafreak.me/',
        'Origin': 'https://ww2.mangafreak.me'
      },
      timeout: 30000
    });

    const $ = cheerio.load(response.data);
    
    // Get the host from the request to build dynamic proxy URLs
    const protocol = req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;
    
    const images = [];
    $('img[id="gohere"]').each((i, elem) => {
      let src = $(elem).attr('src');
      if (src) {
        const proxiedSrc = `${baseUrl}/proxy?url=${encodeURIComponent(src)}`;
        
        images.push({
          originalSrc: src,
          src: proxiedSrc,
          alt: $(elem).attr('alt') || '',
          pageNumber: i + 1
        });
      }
    });

    const title = $('title').text();
    
    res.json({
      success: true,
      series,
      chapter,
      chapterTitle: title,
      totalPages: images.length,
      images
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch manga chapter',
      details: error.message
    });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Manga Scraper API with Custom Proxy',
    endpoints: {
      proxy: '/proxy?url=YOUR_URL',
      scrapeChapter: '/api/scrape-chapter?url=YOUR_URL',
      getManga: '/api/manga/:series/:chapter'
    },
    examples: {
      manga: `http://localhost:${PORT}/api/manga/Chainsaw_Man/218`,
      scrape: `http://localhost:${PORT}/api/scrape-chapter?url=https://ww2.mangafreak.me/Read1_Chainsaw_Man_218`,
      proxy: `http://localhost:${PORT}/proxy?url=https://images.mangafreak.me/mangas/chainsaw_man/chainsaw_man_218/chainsaw_man_218_3.jpg`
    }
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Manga Scraper API running on http://localhost:${PORT}`);
  console.log(`📦 Custom proxy available at http://localhost:${PORT}/proxy`);
  console.log(`\n📖 Example usage:`);
  console.log(`   http://localhost:${PORT}/api/manga/Chainsaw_Man/218`);
  console.log(`\n🖼️  Proxy any image:`);
  console.log(`   http://localhost:${PORT}/proxy?url=IMAGE_URL`);
});