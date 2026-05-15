// providers/mangahere.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');

const router = express.Router();

// Helper: small sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Root provider info (JSON only)
 */
router.get('/', (req, res) => {
  const base = '/manga/mangahere';
  res.json({
    provider: 'mangahere.cc (mangahere provider)',
    base,
    description: 'mangahere provider — image proxy, chapter scraper and chapter ZIP downloader (mounted under /manga/mangahere).',
    endpoints: {
      proxyImage: {
        method: 'GET',
        path: `${base}/proxy-image`,
        query: 'url (required), referer (optional)',
        example: `${base}/proxy-image?url=https://example.com/img.jpg&referer=https://mangahere.cc/`
      },
      scrapeChapter: {
        method: 'GET',
        path: `${base}/scrape-chapter`,
        query: 'url (required) - full chapter page URL to scrape for images',
        example: `${base}/scrape-chapter?url=https://mangahere.cc/read/series/chapter-1`
      },
      downloadChapter: {
        method: 'GET',
        path: `${base}/download-chapter`,
        query: 'chapterId (required) - e.g. series/chapter-1 (this provider uses an upstream read endpoint)',
        example: `${base}/download-chapter?chapterId=kaoru_hana_wa_rin_to_saku/c001`
      }
    },
    notes: [
      'proxy-image returns the raw image bytes and caches images for 24h via Cache-Control header.',
      'scrape-chapter returns JSON: { success, count, images: [{ page, img, headerForImage }] }',
      'download-chapter expects upstream chapter JSON (array) and builds a ZIP of pages (streamed).',
      'Be mindful of rate limiting and polite scraping (throttling recommended for heavy usage).'
    ]
  });
});

/**
 * Proxy endpoint for images
 * GET /proxy-image?url=...&referer=...
 * returns raw image bytes with caching headers
 */
router.get('/proxy-image', async (req, res) => {
  const { url, referer } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const response = await axios({
      method: 'GET',
      url,
      responseType: 'arraybuffer',
      headers: {
        'Referer': referer || 'https://www.mangahere.cc/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'keep-alive'
      },
      timeout: 10000,
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400
    });

    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400'); // cache for 1 day
    res.send(response.data);
  } catch (error) {
    console.error('Error proxying image:', error.message);
    res.status(500).json({ error: 'Failed to fetch image', message: error.message });
  }
});

/**
 * Scrape chapter page for images
 * GET /scrape-chapter?url=FULL_CHAPTER_URL
 * returns JSON: { success, count, images: [{ page, img, headerForImage }] }
 */
router.get('/scrape-chapter', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter is required' });
  }

  try {
    const response = await axios({
      method: 'GET',
      url,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://www.mangahere.cc/'
      },
      timeout: 10000,
      maxRedirects: 5
    });

    const $ = cheerio.load(response.data);
    const images = [];

    $('img.reader-main-img, img[data-src], .viewer img').each((i, elem) => {
      const imgUrl = $(elem).attr('src') || $(elem).attr('data-src');
      if (imgUrl && imgUrl.includes('mangahere')) {
        images.push({ page: i, img: imgUrl, headerForImage: { Referer: url } });
      }
    });

    if (images.length === 0) {
      $('img').each((i, elem) => {
        const imgUrl = $(elem).attr('src') || $(elem).attr('data-src');
        if (imgUrl && (imgUrl.includes('zjcdn') || imgUrl.includes('mangahere') || imgUrl.includes('mangapill') || imgUrl.includes('cdn'))) {
          images.push({ page: i, img: imgUrl, headerForImage: { Referer: url } });
        }
      });
    }

    res.json({ success: true, count: images.length, images });
  } catch (error) {
    console.error('Error scraping chapter:', error.message);
    res.status(500).json({ error: 'Failed to scrape chapter', message: error.message });
  }
});

/**
 * Download chapter as ZIP
 * GET /download-chapter?chapterId=series/chapter-xyz
 */
router.get('/download-chapter', async (req, res) => {
  const { chapterId } = req.query;

  if (!chapterId) {
    return res.status(400).json({ error: 'chapterId parameter is required' });
  }

  try {
    const apiUrl = `https://kangaroo-kappa.vercel.app/manga/mangahere/read?chapterId=${encodeURIComponent(chapterId)}`;
    console.log(`Fetching chapter from API: ${apiUrl}`);

    const response = await axios({
      method: 'GET',
      url: apiUrl,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 15000
    });

    const chapterData = response.data;
    if (!Array.isArray(chapterData) || chapterData.length === 0) {
      return res.status(404).json({ error: 'No images found in chapter' });
    }

    const archive = archiver('zip', { zlib: { level: 9 } });
    const chapterName = chapterId.replace(/\//g, '_');
    res.attachment(`${chapterName}.zip`);
    res.setHeader('Content-Type', 'application/zip');
    archive.pipe(res);

    let successCount = 0;
    for (let i = 0; i < chapterData.length; i++) {
      const pageData = chapterData[i];
      const imageUrl = pageData.img;
      const referer = pageData.headerForImage?.Referer || 'https://www.mangahere.cc/';
      const pageNum = String((pageData.page ?? i) + 1).padStart(3, '0');

      try {
        const imageResponse = await axios({
          method: 'GET',
          url: imageUrl,
          responseType: 'arraybuffer',
          headers: { 'Referer': referer, 'User-Agent': 'Mozilla/5.0' },
          timeout: 20000
        });

        if (imageResponse.data && imageResponse.data.byteLength > 0) {
          const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
          const ext = contentType.split('/')[1] || 'jpg';
          archive.append(Buffer.from(imageResponse.data), { name: `page_${pageNum}.${ext}` });
          successCount++;
        }
      } catch (error) {
        console.error(`Failed to download image ${i + 1}:`, error.message);
      }

      await sleep(150);
    }

    await archive.finalize();
    console.log(`Archive complete: ${successCount}/${chapterData.length} images`);
  } catch (error) {
    console.error('Error downloading chapter:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to download chapter', message: error.message });
    }
  }
});

module.exports = router;
