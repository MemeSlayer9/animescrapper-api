const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all routes
app.use(cors());

// Parse JSON bodies
app.use(express.json());

// Root route
app.get('/', (req, res) => {
  res.json({
    message: 'Manga Image Proxy Server',
    endpoints: {
      '/api/proxy-image': 'GET - Proxy manga images (requires url and referer query params)',
      '/api/scrape-chapter': 'GET - Scrape chapter images (requires url query param)',
      '/api/download-chapter': 'GET - Download chapter as ZIP (requires chapterId query param)'
    }
  });
});

// Proxy endpoint for images
app.get('/api/proxy-image', async (req, res) => {
  const { url, referer } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      headers: {
        'Referer': referer || 'https://www.mangahere.cc/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      },
      timeout: 10000
    });

    // Set appropriate headers
    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    res.send(response.data);
  } catch (error) {
    console.error('Error proxying image:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch image',
      message: error.message 
    });
  }
});

// Scrape chapter page for images
app.get('/api/scrape-chapter', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const response = await axios({
      method: 'GET',
      url: url,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.mangahere.cc/'
      }
    });

    const $ = cheerio.load(response.data);
    const images = [];

    // Try to find images - adjust selectors based on the site structure
    $('img.reader-main-img, img[data-src], .viewer img').each((i, elem) => {
      const imgUrl = $(elem).attr('src') || $(elem).attr('data-src');
      if (imgUrl && imgUrl.includes('mangahere')) {
        images.push({
          page: i,
          img: imgUrl,
          headerForImage: {
            Referer: url
          }
        });
      }
    });

    // If no images found with above selectors, try alternative approach
    if (images.length === 0) {
      $('img').each((i, elem) => {
        const imgUrl = $(elem).attr('src') || $(elem).attr('data-src');
        if (imgUrl && (imgUrl.includes('zjcdn') || imgUrl.includes('mangahere'))) {
          images.push({
            page: i,
            img: imgUrl,
            headerForImage: {
              Referer: url
            }
          });
        }
      });
    }

    res.json({
      success: true,
      count: images.length,
      images: images
    });
  } catch (error) {
    console.error('Error scraping chapter:', error.message);
    res.status(500).json({ 
      error: 'Failed to scrape chapter',
      message: error.message 
    });
  }
});

// Download chapter as ZIP
app.get('/api/download-chapter', async (req, res) => {
  const { chapterId } = req.query;

  if (!chapterId) {
    return res.status(400).json({ error: 'chapterId parameter is required' });
  }

  try {
    // Fetch chapter data from the Kangaroo API
    const apiUrl = `https://kangaroo-kappa.vercel.app/manga/mangahere/read?chapterId=${chapterId}`;
    
    console.log(`Fetching chapter from API: ${apiUrl}`);

    const response = await axios({
      method: 'GET',
      url: apiUrl,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    const chapterData = response.data;

    if (!Array.isArray(chapterData) || chapterData.length === 0) {
      return res.status(404).json({ error: 'No images found in chapter' });
    }

    console.log(`Found ${chapterData.length} images`);

    // Set up the ZIP archive
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    // Set response headers for ZIP download
    const chapterName = chapterId.replace(/\//g, '_');
    res.attachment(`${chapterName}.zip`);
    res.setHeader('Content-Type', 'application/zip');

    // Handle archive errors
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive' });
      }
    });

    // Track successful downloads
    let successCount = 0;

    // Download each image and add to archive
    for (let i = 0; i < chapterData.length; i++) {
      const pageData = chapterData[i];
      const imageUrl = pageData.img;
      const referer = pageData.headerForImage?.Referer || 'https://www.mangahere.cc/';
      const pageNum = String(pageData.page + 1).padStart(3, '0');
      
      try {
        console.log(`Downloading image ${i + 1}/${chapterData.length}: ${imageUrl}`);
        
        const imageResponse = await axios({
          method: 'GET',
          url: imageUrl,
          responseType: 'arraybuffer',
          headers: {
            'Referer': referer,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
          },
          timeout: 20000,
          maxRedirects: 5
        });

        if (imageResponse.data && imageResponse.data.byteLength > 0) {
          // Determine file extension from content-type
          const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
          const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
          
          // Add image to archive
          archive.append(Buffer.from(imageResponse.data), { 
            name: `page_${pageNum}.${ext}` 
          });
          
          successCount++;
          console.log(`✓ Added page ${pageNum} (${imageResponse.data.byteLength} bytes) - Total: ${successCount}`);
        } else {
          console.error(`✗ Empty response for image ${i + 1}`);
        }

      } catch (error) {
        console.error(`✗ Failed to download image ${i + 1}:`, error.message);
        // Continue with other images even if one fails
      }
      
      // Add small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    console.log(`Download complete: ${successCount}/${chapterData.length} images`);

    // Pipe archive to response AFTER all images are added
    archive.pipe(res);

    // Finalize the archive
    await archive.finalize();
    console.log('Archive finalized and sent');

  } catch (error) {
    console.error('Error downloading chapter:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to download chapter',
        message: error.message 
      });
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📖 API Documentation: http://localhost:${PORT}`);
});

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

module.exports = app;