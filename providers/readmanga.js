// providers/readmanga.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');

const router = express.Router();
const ANILIST_API = 'https://graphql.anilist.co';

// common headers helper
const defaultHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://readmanga.cc/'
};

function generateSlugVariations(title) {
  if (!title) return [];
  const baseSlug = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  const variations = [
    baseSlug,
    `${baseSlug}-2`,
    `${baseSlug}-3`,
    `${baseSlug}-4`,
    `${baseSlug}-5`,
    baseSlug.replace(/-/g, ''),
    baseSlug.replace(/-/g, ' ').replace(/\s+/g, '-')
  ];
  return [...new Set(variations)];
}

async function findMangaSlugOnSite(searchTitle) {
  try {
    const searchUrl = `https://readmanga.cc/?s=${encodeURIComponent(searchTitle)}`;
    const response = await axios.get(searchUrl, { headers: { ...defaultHeaders }, timeout: 10000 });
    const $ = cheerio.load(response.data);
    const results = [];
    $('a[href*="/manga/"]').each((i, elem) => {
      const href = $(elem).attr('href');
      const title = $(elem).text().trim() || $(elem).find('h3, h4, h5').text().trim();
      if (href && href.includes('/manga/') && title) {
        const slug = href.replace(/.*\/manga\//, '').replace(/\/$/, '');
        if (!results.some(r => r.slug === slug)) {
          results.push({ slug, title, url: href.startsWith('http') ? href : `https://readmanga.cc${href}` });
        }
      }
    });
    return results;
  } catch (error) {
    console.error(`Search failed for "${searchTitle}":`, error.message);
    return [];
  }
}

/* ---------------------------
   AniList by ID (search slugs)
   endpoint: GET /anilist-chapters/:anilistId
   optional query param: ?slug=EXACT_SLUG (if you already know it)
   --------------------------- */
router.get('/anilist-chapters/:anilistId', async (req, res) => {
  try {
    const targetAnilistId = parseInt(req.params.anilistId);
    const maybeSlug = req.query.slug;

    // If user provided slug, try direct fetch first
    if (maybeSlug) {
      try {
        const testUrl = `https://readmanga.cc/manga/${maybeSlug}`;
        const r = await axios.get(testUrl, { headers: defaultHeaders, timeout: 10000, validateStatus: s => s === 200 });
        // if 200, fallback to the same chapter scraping logic below by redirecting
        // but we'll continue to extract meta and chapters here
      } catch (e) {
        // continue to full search if provided slug didn't work
      }
    }

    const query = `query ($id: Int) {
      Media(id: $id, type: MANGA) {
        id
        title { romaji english native userPreferred }
        synonyms
      }
    }`;

    const anilistResponse = await axios.post(ANILIST_API, { query, variables: { id: targetAnilistId } }, { headers: { 'Content-Type': 'application/json' } });
    if (anilistResponse.data.errors) {
      return res.status(400).json({ success: false, error: 'Invalid AniList ID', details: anilistResponse.data.errors });
    }
    const media = anilistResponse.data.data.Media;
    const allTitles = [
      media.title.english,
      media.title.romaji,
      media.title.native,
      media.title.userPreferred,
      ...(media.synonyms || [])
    ].filter(Boolean);

    const normalizedTitles = allTitles.map(t => t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim());
    const allSlugVariations = [];
    for (const title of allTitles) {
      allSlugVariations.push(...generateSlugVariations(title));
    }
    const uniqueSlugs = [...new Set(allSlugVariations)].slice(0, 50);

    let foundSlug = null;
    let matchMethod = null;
    let matchedTitle = null;

    for (const slug of uniqueSlugs) {
      try {
        const testUrl = `https://readmanga.cc/manga/${slug}`;
        const response = await axios.get(testUrl, { headers: defaultHeaders, timeout: 10000, validateStatus: s => s === 200 });
        const $ = cheerio.load(response.data);

        // try to detect AniList reference on page
        let pageAnilistId = null;
        $('a[href*="anilist.co"]').each((i, elem) => {
          const href = $(elem).attr('href') || '';
          const m = href.match(/anilist\.co\/manga\/(\d+)/);
          if (m) {
            pageAnilistId = parseInt(m[1]);
            return false;
          }
        });
        if (!pageAnilistId) {
          $('meta, script, [data-anilist]').each((i, elem) => {
            const content = $(elem).attr('content') || $(elem).html() || $(elem).attr('data-anilist') || '';
            const m = content.match(/anilist\.co\/manga\/(\d+)/);
            if (m) {
              pageAnilistId = parseInt(m[1]);
              return false;
            }
          });
        }

        const pageMangaTitle = $('h1, .manga-title, .entry-title').first().text().trim();
        const normalizedPageTitle = (pageMangaTitle || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

        if (pageAnilistId === targetAnilistId) {
          foundSlug = slug; matchMethod = 'anilist_id'; matchedTitle = pageMangaTitle;
          break;
        }

        if (pageMangaTitle) {
          for (let i = 0; i < normalizedTitles.length; i++) {
            const searchTitle = normalizedTitles[i];
            if (normalizedPageTitle === searchTitle || normalizedPageTitle.includes(searchTitle) || searchTitle.includes(normalizedPageTitle)) {
              foundSlug = slug; matchMethod = 'title_match'; matchedTitle = pageMangaTitle;
              break;
            }
          }
          if (foundSlug) break;
        }
      } catch (err) {
        // skip on 404s/timeouts/errors
        continue;
      }
    }

    if (!foundSlug) {
      return res.status(404).json({
        success: false,
        error: 'Could not find manga on readmanga.cc',
        anilistId: targetAnilistId,
        searchedTitles: allTitles,
        triedSlugs: uniqueSlugs.slice(0, 20),
        message: 'The manga might not be available on readmanga.cc, uses a very different title, or requires manual slug input'
      });
    }

    // fetch chapters list
    const chaptersUrl = `https://readmanga.cc/manga/${foundSlug}`;
    const chaptersResponse = await axios.get(chaptersUrl, { headers: defaultHeaders });
    const $ = cheerio.load(chaptersResponse.data);
    const chapters = [];
    $('a[data-chapter]').each((i, elem) => {
      const $elem = $(elem);
      const chapterNumber = $elem.attr('data-chapter');
      const href = $elem.attr('href');
      const chapterTitle = $elem.find('h5').text().trim();
      const timeAgo = $elem.find('p').text().trim();
      const id = href ? href.replace('https://readmanga.cc/read/', '').replace(/^\/read\//, '') : null;
      if (id) {
        chapters.push({
          id,
          chapterNumber,
          title: chapterTitle,
          url: href && href.startsWith('http') ? href : `https://readmanga.cc${href}`,
          timeAgo
        });
      }
    });

    const mangaTitle = $('h1, .manga-title, .entry-title').first().text().trim() || 'Unknown Manga';
    res.json({
      success: true,
      detectedSlug: foundSlug,
      matchMethod,
      matchedTitle,
      manga: {
        mangaSlug: foundSlug,
        mangaId: foundSlug,
        mangaTitle,
        url: chaptersUrl,
        chapters,
        totalChapters: chapters.length,
        scrapedChapterCount: chapters.length,
        anilistId: targetAnilistId,
        title: media.title,
        anilistUrl: `https://anilist.co/manga/${targetAnilistId}`
      }
    });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to fetch manga data from AniList ID' });
  }
});

/* ---------------------------
   AniList search: GET /anilist-search?query=...
   --------------------------- */
router.get('/anilist-search', async (req, res) => {
  try {
    const searchQuery = req.query.query;
    if (!searchQuery) return res.status(400).json({ success: false, error: 'query parameter is required', example: '/anilist-search?query=Blue Lock' });

    const query = `query ($search: String, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { total currentPage lastPage hasNextPage perPage }
        media(search: $search, type: MANGA, sort: POPULARITY_DESC) {
          id title { romaji english native } description coverImage { large extraLarge } bannerImage genres averageScore popularity status chapters volumes format startDate { year month day } siteUrl
        }
      }
    }`;

    const variables = { search: searchQuery, page: parseInt(req.query.page) || 1, perPage: parseInt(req.query.perPage) || 10 };
    const response = await axios.post(ANILIST_API, { query, variables }, { headers: { 'Content-Type': 'application/json' } });
    if (response.data.errors) return res.status(400).json({ success: false, error: 'AniList API error', details: response.data.errors });

    const page = response.data.data.Page;
    const results = page.media.map(manga => {
      const cleanDescription = manga.description ? manga.description.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim().substring(0, 200) + '...' : null;
      return {
        id: manga.id,
        title: manga.title,
        description: cleanDescription,
        coverImage: manga.coverImage,
        bannerImage: manga.bannerImage,
        genres: manga.genres,
        averageScore: manga.averageScore,
        popularity: manga.popularity,
        status: manga.status,
        chapters: manga.chapters,
        volumes: manga.volumes,
        format: manga.format,
        startDate: manga.startDate,
        anilistUrl: manga.siteUrl
      };
    });

    res.json({ success: true, pageInfo: page.pageInfo, results });
  } catch (error) {
    console.error('AniList search error:', error.message);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to search manga on AniList' });
  }
});

/* ---------------------------
   Debug HTML structure: GET /debug?url=...
   --------------------------- */
router.get('/debug', async (req, res) => {
  try {
    const url = req.query.url || 'https://readmanga.cc/read/blue-lock-3/chapter-322';
    const response = await axios.get(url, { headers: defaultHeaders });
    const $ = cheerio.load(response.data);
    const allImages = [];
    $('img').each((i, elem) => {
      allImages.push({
        src: $(elem).attr('src'),
        dataSrc: $(elem).attr('data-src'),
        dataLazySrc: $(elem).attr('data-lazy-src'),
        dataOriginal: $(elem).attr('data-original'),
        class: $(elem).attr('class'),
        id: $(elem).attr('id'),
        alt: $(elem).attr('alt')
      });
    });

    const imageDivs = [];
    $('div[style*="background-image"], div[data-src], div[data-image]').each((i, elem) => {
      imageDivs.push({
        class: $(elem).attr('class'),
        id: $(elem).attr('id'),
        style: $(elem).attr('style'),
        dataSrc: $(elem).attr('data-src'),
        dataImage: $(elem).attr('data-image')
      });
    });

    const scripts = [];
    $('script').each((i, elem) => {
      const content = $(elem).html();
      if (content && (content.includes('images') || content.includes('pages') || content.includes('.jpg') || content.includes('.png'))) {
        scripts.push({ index: i, snippet: content.substring(0, 500) });
      }
    });

    res.json({ success: true, url, allImages, imageDivs, scriptsWithImages: scripts, totalImgTags: allImages.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* ---------------------------
   Read chapter: GET /read/:manga/:chapter
   --------------------------- */
router.get('/read/:manga/:chapter', async (req, res) => {
  try {
    const { manga, chapter } = req.params;
    const url = `https://readmanga.cc/read/${manga}/${chapter}`;
    const response = await axios.get(url, { headers: defaultHeaders });
    const $ = cheerio.load(response.data);
    const images = [];

    const selectors = [
      'img.page-img', 'img.manga-page', '.reader-image img', '#reader img',
      '.reading-content img', '.page-break img', 'div#readerarea img', 'div.reading-content img',
      'img[data-src]', 'img.lazyload', '.chapter-content img', 'img[alt*="page"]',
      'img[src*=".jpg"], img[src*=".png"], img[src*=".webp"]'
    ];

    for (const selector of selectors) {
      $(selector).each((i, elem) => {
        const src = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-lazy-src') || $(elem).attr('data-original');
        if (src && !images.some(img => img.src === src)) {
          images.push({ page: images.length + 1, src: src.startsWith('http') ? src : `https://readmanga.cc${src}` });
        }
      });
      if (images.length > 0) break;
    }

    if (images.length === 0) {
      $('script').each((i, elem) => {
        const scriptContent = $(elem).html();
        if (scriptContent) {
          const urlMatches = scriptContent.match(/https?:\/\/[^"'\s]+\.(jpg|jpeg|png|webp)/gi);
          if (urlMatches) {
            urlMatches.forEach(url => {
              if (!images.some(img => img.src === url)) {
                images.push({ page: images.length + 1, src: url });
              }
            });
          }
        }
      });
    }

    const title = $('title').text() || 'No title found';
    const chapterTitle = $('.chapter-title, .reader-title, h1, .entry-title').first().text().trim() || 'Unknown Chapter';

    res.json({ success: true, id: `${manga}/${chapter}`, url, title, chapterTitle, totalPages: images.length, images });
  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to scrape manga page' });
  }
});

/* ---------------------------
   Chapters list: GET /chapters/:manga
   --------------------------- */
router.get('/chapters/:manga', async (req, res) => {
  try {
    const { manga } = req.params;
    const url = `https://readmanga.cc/manga/${manga}`;
    const response = await axios.get(url, { headers: defaultHeaders });
    const $ = cheerio.load(response.data);
    const chapters = [];
    $('a[data-chapter]').each((i, elem) => {
      const $elem = $(elem);
      const chapterNumber = $elem.attr('data-chapter');
      const href = $elem.attr('href');
      const title = $elem.find('h5').text().trim();
      const timeAgo = $elem.find('p').text().trim();
      const id = href ? href.replace('https://readmanga.cc/read/', '').replace(/^\/read\//, '') : null;
      if (id) {
        chapters.push({
          id,
          chapterNumber,
          title,
          url: href && href.startsWith('http') ? href : `https://readmanga.cc${href}`,
          timeAgo
        });
      }
    });

    const mangaTitle = $('h1, .manga-title, .entry-title').first().text().trim() || 'Unknown Manga';
    res.json({ success: true, mangaId: manga, url, mangaTitle, totalChapters: chapters.length, chapters });
  } catch (error) {
    console.error('Chapter scraping error:', error.message);
    res.status(500).json({ success: false, error: error.message, message: 'Failed to scrape chapter list' });
  }
});

/* ---------------------------
   Download single chapter: GET /download?chapterId=series/chapter-xyz
   --------------------------- */
router.get('/download', async (req, res) => {
  try {
    const chapterId = req.query.chapterId;
    if (!chapterId) return res.status(400).json({ success: false, error: 'chapterId parameter is required', example: '/download?chapterId=25d-seduction/chapter-196' });

    const url = `https://readmanga.cc/read/${chapterId}`;
    const response = await axios.get(url, { headers: defaultHeaders });
    const $ = cheerio.load(response.data);

    const images = [];
    const selectors = [
      'img.page-img', 'img.manga-page', '.reader-image img', '#reader img',
      '.reading-content img', '.page-break img', 'div#readerarea img', 'div.reading-content img',
      'img[data-src]', 'img.lazyload', '.chapter-content img', 'img[alt*="page"]',
      'img[src*=".jpg"], img[src*=".png"], img[src*=".webp"]'
    ];

    for (const selector of selectors) {
      $(selector).each((i, elem) => {
        const src = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-lazy-src') || $(elem).attr('data-original');
        if (src && !images.some(img => img.src === src)) {
          images.push({ page: images.length + 1, src: src.startsWith('http') ? src : `https://readmanga.cc${src}` });
        }
      });
      if (images.length > 0) break;
    }

    if (images.length === 0) {
      $('script').each((i, elem) => {
        const scriptContent = $(elem).html();
        if (scriptContent) {
          const urlMatches = scriptContent.match(/https?:\/\/[^"'\s]+\.(jpg|jpeg|png|webp)/gi) || [];
          urlMatches.forEach(url => {
            if (!images.some(img => img.src === url)) images.push({ page: images.length + 1, src: url });
          });
        }
      });
    }

    if (images.length === 0) return res.status(404).json({ success: false, error: 'No images found in the chapter' });

    const archive = archiver('zip', { zlib: { level: 9 } });
    const sanitizedChapterId = chapterId.replace(/[^a-zA-Z0-9-]/g, '_');
    res.attachment(`${sanitizedChapterId}.zip`);
    res.setHeader('Content-Type', 'application/zip');
    archive.pipe(res);

    for (let i = 0; i < images.length; i++) {
      try {
        const imageResponse = await axios.get(images[i].src, { responseType: 'arraybuffer', headers: { 'User-Agent': defaultHeaders['User-Agent'], 'Referer': 'https://readmanga.cc/' }, timeout: 30000 });
        const contentType = imageResponse.headers['content-type'] || '';
        let extension = 'jpg';
        if (contentType.includes('png')) extension = 'png';
        else if (contentType.includes('webp')) extension = 'webp';
        else if (contentType.includes('jpeg')) extension = 'jpg';
        else {
          const urlExt = images[i].src.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
          if (urlExt) extension = urlExt[1];
        }
        const pageNumber = String(i + 1).padStart(3, '0');
        archive.append(Buffer.from(imageResponse.data), { name: `page_${pageNumber}.${extension}` });
      } catch (imageError) {
        console.error(`Failed to download image ${i + 1}:`, imageError.message);
      }
    }

    await archive.finalize();
  } catch (error) {
    console.error('Download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message, message: 'Failed to create chapter download' });
    } else {
      // headers already sent, can't send JSON
      console.error('Headers already sent, cannot return JSON error.');
    }
  }
});

/* ---------------------------
   Download multiple chapters: GET /download-multiple-chapters?chapterIds=id1,id2&folderName=...
   --------------------------- */
router.get('/download-multiple-chapters', async (req, res) => {
  try {
    const chapterIdsParam = req.query.chapterIds;
    const folderName = req.query.folderName || 'Manga Chapters';
    if (!chapterIdsParam) return res.status(400).json({ success: false, error: 'chapterIds parameter is required', example: '/download-multiple-chapters?chapterIds=25d-seduction/chapter-196,25d-seduction/chapter-195&folderName=2.5D Seduction' });

    const chapterIds = chapterIdsParam.split(',').map(id => id.trim()).filter(Boolean);
    if (chapterIds.length === 0) return res.status(400).json({ success: false, error: 'No valid chapter IDs provided' });

    const archive = archiver('zip', { zlib: { level: 9 } });
    const sanitizedFolderName = folderName.replace(/[^a-zA-Z0-9-_ ]/g, '_');
    res.attachment(`${sanitizedFolderName}.zip`);
    res.setHeader('Content-Type', 'application/zip');
    archive.pipe(res);

    for (const chapterId of chapterIds) {
      try {
        const url = `https://readmanga.cc/read/${chapterId}`;
        const response = await axios.get(url, { headers: defaultHeaders });
        const $ = cheerio.load(response.data);
        const images = [];
        const selectors = [
          'img.page-img', 'img.manga-page', '.reader-image img', '#reader img',
          '.reading-content img', '.page-break img', 'div#readerarea img', 'div.reading-content img',
          'img[data-src]', 'img.lazyload', '.chapter-content img', 'img[alt*="page"]',
          'img[src*=".jpg"], img[src*=".png"], img[src*=".webp"]'
        ];

        for (const selector of selectors) {
          $(selector).each((i, elem) => {
            const src = $(elem).attr('src') || $(elem).attr('data-src') || $(elem).attr('data-lazy-src') || $(elem).attr('data-original');
            if (src && !images.some(img => img.src === src)) {
              images.push({ page: images.length + 1, src: src.startsWith('http') ? src : `https://readmanga.cc${src}` });
            }
          });
          if (images.length > 0) break;
        }

        if (images.length === 0) {
          $('script').each((i, elem) => {
            const scriptContent = $(elem).html();
            if (scriptContent) {
              const urlMatches = scriptContent.match(/https?:\/\/[^"'\s]+\.(jpg|jpeg|png|webp)/gi);
              if (urlMatches) {
                urlMatches.forEach(url => {
                  if (!images.some(img => img.src === url)) images.push({ page: images.length + 1, src: url });
                });
              }
            }
          });
        }

        if (images.length === 0) {
          console.warn(`No images found for chapter: ${chapterId}`);
          continue;
        }

        const chapterFolderName = chapterId.replace(/[^a-zA-Z0-9-]/g, '_');

        for (let i = 0; i < images.length; i++) {
          try {
            const imageResponse = await axios.get(images[i].src, { responseType: 'arraybuffer', headers: { 'User-Agent': defaultHeaders['User-Agent'], 'Referer': 'https://readmanga.cc/' }, timeout: 30000 });
            const contentType = imageResponse.headers['content-type'] || '';
            let extension = 'jpg';
            if (contentType.includes('png')) extension = 'png';
            else if (contentType.includes('webp')) extension = 'webp';
            else if (contentType.includes('jpeg')) extension = 'jpg';
            else {
              const urlExt = images[i].src.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
              if (urlExt) extension = urlExt[1];
            }
            const pageNumber = String(i + 1).padStart(3, '0');
            archive.append(Buffer.from(imageResponse.data), { name: `${chapterFolderName}/page_${pageNumber}.${extension}` });
          } catch (imageError) {
            console.error(`Failed to download image ${i + 1} from ${chapterId}:`, imageError.message);
          }
        }

        console.log(`Successfully processed chapter: ${chapterId} (${images.length} images)`);
      } catch (chapterError) {
        console.error(`Failed to process chapter ${chapterId}:`, chapterError.message);
      }
    }

    await archive.finalize();
  } catch (error) {
    console.error('Multiple download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message, message: 'Failed to create multiple chapters download' });
    }
  }
});

// Optionally expose search helper
router.get('/search-site', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ success: false, error: 'q param required' });
    const results = await findMangaSlugOnSite(q);
    res.json({ success: true, results });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Add this to providers/readmanga.js (place before module.exports = router;)

router.get('/', (req, res) => {
  res.json({
    provider: 'readmanga.cc',
    base: '/manga/readmanga',
    description: 'ReadManga provider: scraping, AniList match, debug and download endpoints (mounted under /manga/readmanga)',
    endpoints: {
      root: { method: 'GET', path: '/manga/readmanga/', description: 'Provider info (this route)' },
      anilistChapters: { method: 'GET', path: '/manga/readmanga/anilist-chapters/:anilistId', description: 'Find manga by AniList ID (tries slug variations)', example: '/manga/readmanga/anilist-chapters/110785?slug=25d-seduction' },
      anilistSearch: { method: 'GET', path: '/manga/readmanga/anilist-search', description: 'Search AniList for manga', example: '/manga/readmanga/anilist-search?query=Blue%20Lock' },
      debug: { method: 'GET', path: '/manga/readmanga/debug', description: 'Return page DOM hints (img tags, scripts etc.)', example: '/manga/readmanga/debug?url=https://readmanga.cc/read/blue-lock-3/chapter-322' },
      read: { method: 'GET', path: '/manga/readmanga/read/:series/:chapter', description: 'Get image URLs for a chapter', example: '/manga/readmanga/read/25d-seduction/chapter-196' },
      chapters: { method: 'GET', path: '/manga/readmanga/chapters/:series', description: 'List chapters for a manga', example: '/manga/readmanga/chapters/25d-seduction' },
      download: { method: 'GET', path: '/manga/readmanga/download', description: 'Download single chapter as ZIP (query param chapterId)', example: '/manga/readmanga/download?chapterId=25d-seduction/chapter-196' },
      downloadMultiple: { method: 'GET', path: '/manga/readmanga/download-multiple-chapters', description: 'Download multiple chapters as a ZIP', example: '/manga/readmanga/download-multiple-chapters?chapterIds=25d-seduction/chapter-196,25d-seduction/chapter-195&folderName=2.5D%20Seduction' },
      searchSite: { method: 'GET', path: '/manga/readmanga/search-site', description: 'Search readmanga.cc for slug suggestions', example: '/manga/readmanga/search-site?q=blue%20lock' }
    }
  });
});


module.exports = router;
