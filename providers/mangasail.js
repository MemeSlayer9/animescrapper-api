// providers/sailmg.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const archiver = require('archiver');
const { request, gql } = require('graphql-request');

const router = express.Router();

// Base URL for sailmg.com
const BASE_URL = 'https://www.sailmg.com/content/';
const ANILIST_API = 'https://graphql.anilist.co';

// GraphQL Queries
const SEARCH_MANGA_BY_ID = gql`
  query ($id: Int) {
    Media(id: $id, type: MANGA) {
      id
      title {
        romaji
        english
        native
      }
      description
      coverImage {
        large
        extraLarge
      }
      bannerImage
      genres
      tags {
        name
      }
      averageScore
      popularity
      status
      chapters
      volumes
      startDate {
        year
        month
        day
      }
      endDate {
        year
        month
        day
      }
      synonyms
      siteUrl
    }
  }
`;

const SEARCH_MANGA_BY_TITLE = gql`
  query ($search: String) {
    Media(search: $search, type: MANGA) {
      id
      title {
        romaji
        english
        native
      }
      description
      coverImage {
        large
        extraLarge
      }
      bannerImage
      genres
      tags {
        name
      }
      averageScore
      popularity
      status
      chapters
      volumes
      startDate {
        year
        month
        day
      }
      endDate {
        year
        month
        day
      }
      synonyms
      siteUrl
    }
  }
`;

// Function to get manga from AniList by ID
async function getAniListManga(mangaId) {
  try {
    const data = await request(ANILIST_API, SEARCH_MANGA_BY_ID, { 
      id: parseInt(mangaId) 
    });
    return data.Media;
  } catch (error) {
    console.error('Error fetching from AniList:', error);
    return null;
  }
}

// Function to search AniList by title
async function searchAniList(mangaTitle) {
  try {
    const data = await request(ANILIST_API, SEARCH_MANGA_BY_TITLE, { 
      search: mangaTitle 
    });
    return data.Media;
  } catch (error) {
    console.error('Error searching AniList:', error);
    return null;
  }
}

// Function to convert manga title to sailmg slug
function titleToSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

// Function to generate possible slug variations
function generateSlugVariations(anilistData) {
  const variations = new Set();
  
  const addVariations = (title) => {
    if (!title) return;
    
    const standardSlug = titleToSlug(title);
    variations.add(standardSlug);
    
    const withoutArticles = title
      .replace(/^(the|a|an)\s+/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
    if (withoutArticles !== standardSlug) {
      variations.add(withoutArticles);
    }
    
    const cleaned = title
      .toLowerCase()
      .replace(/['':]/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
    variations.add(cleaned);
    
    const withSpelledNumbers = title
      .replace(/\b1\b/g, 'one')
      .replace(/\b2\b/g, 'two')
      .replace(/\b3\b/g, 'three')
      .replace(/\b4\b/g, 'four')
      .replace(/\b5\b/g, 'five');
    if (withSpelledNumbers !== title) {
      variations.add(titleToSlug(withSpelledNumbers));
    }
  };
  
  if (anilistData.title.romaji) addVariations(anilistData.title.romaji);
  if (anilistData.title.english) addVariations(anilistData.title.english);
  if (anilistData.title.native) addVariations(anilistData.title.native);
  
  if (anilistData.synonyms && anilistData.synonyms.length > 0) {
    anilistData.synonyms.forEach(synonym => addVariations(synonym));
  }
  
  return Array.from(variations).filter(v => v.length > 0);
}

// Helper function to construct URL from chapterId
function getChapterUrl(chapterId) {
  return `${BASE_URL}${chapterId}`;
}

// Function to scrape chapters from a SINGLE page only
async function scrapeChaptersFromPage(url, mangaSlug) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://www.sailmg.com/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    }
  });

  const $ = cheerio.load(response.data);
  const chapters = [];
  
  const mangaPattern = mangaSlug.toLowerCase().replace(/-/g, '');

  $('.chapter-item, .chapter, a[href*="/content/"]').each((i, elem) => {
    const href = $(elem).attr('href');
    const text = $(elem).text().trim();
    
    if (href && text && href.includes('/content/') && !href.includes('?')) {
      const hrefLower = href.toLowerCase().replace(/-/g, '');
      const titleLower = text.toLowerCase().replace(/\s+/g, '');
      
      if (titleLower.includes(mangaPattern) && /\d+/.test(text)) {
        const fullUrl = href.startsWith('http') ? href : `https://www.sailmg.com${href}`;
        const chapterId = href.split('/content/')[1]?.split('?')[0] || '';
        
        chapters.push({
          title: text,
          chapterId: chapterId,
          url: fullUrl,
          href: href
        });
      }
    }
  });

  const paginationInfo = {
    hasNext: false,
    hasPrevious: false,
    currentPage: null,
    totalPages: null
  };

  const pageMatch = url.match(/[?&]page=(\d+)/);
  if (pageMatch) {
    paginationInfo.currentPage = parseInt(pageMatch[1]);
  } else {
    paginationInfo.currentPage = 0;
  }

  const nextSelectors = [
    'a.pager-next',
    '.pager__item--next a',
    'a[rel="next"]',
    '.pager-item.next a',
    'li.next a',
    '.pagination .next a'
  ];

  for (const selector of nextSelectors) {
    const nextLink = $(selector).first();
    if (nextLink.length > 0 && nextLink.attr('href')) {
      paginationInfo.hasNext = true;
      break;
    }
  }

  const prevSelectors = [
    'a.pager-previous',
    '.pager__item--previous a',
    'a[rel="prev"]',
    '.pager-item.previous a',
    'li.previous a',
    '.pagination .previous a'
  ];

  for (const selector of prevSelectors) {
    const prevLink = $(selector).first();
    if (prevLink.length > 0 && prevLink.attr('href')) {
      paginationInfo.hasPrevious = true;
      break;
    }
  }

  return { chapters, paginationInfo };
}

// Function to find the working slug for a manga
async function findWorkingSlug(slugVariations) {
  for (const slug of slugVariations) {
    try {
      console.log(`Testing slug: ${slug}`);
      const url = getChapterUrl(slug);
      
      const headResponse = await axios.head(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.sailmg.com/'
        },
        timeout: 5000
      });
      
      if (headResponse.status === 200) {
        console.log(`✓ Found working slug: ${slug}`);
        return slug;
      }
    } catch (e) {
      continue;
    }
  }
  
  return null;
}

// Function to scrape manga images
async function scrapeMangaImages(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.sailmg.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br'
      }
    });

    const $ = cheerio.load(response.data);
    const images = [];

    // Method 1: Extract from Drupal.settings.showmanga.paths
    $('script').each((i, elem) => {
      const scriptContent = $(elem).html();
      if (scriptContent && scriptContent.includes('Drupal.settings')) {
        try {
          const drupalMatch = scriptContent.match(/jQuery\.extend\(Drupal\.settings,\s*({[\s\S]*?})\);/);
          if (drupalMatch) {
            const settingsJson = drupalMatch[1];
            const settings = JSON.parse(settingsJson);
            
            if (settings.showmanga && settings.showmanga.paths && Array.isArray(settings.showmanga.paths)) {
              settings.showmanga.paths.forEach((path, idx) => {
                if (typeof path === 'string' && path.startsWith('http') && /\.(jpg|jpeg|png|gif|webp)$/i.test(path)) {
                  images.push({
                    index: idx,
                    src: path,
                    source: 'drupal-settings',
                    fullUrl: path
                  });
                }
              });
              
              if (images.length > 0) {
                return false;
              }
            }
          }
        } catch (e) {
          console.error('Failed to parse Drupal settings:', e.message);
        }
      }
    });

    // Method 2: Find manga images with 'name' attribute
    if (images.length === 0) {
      $('img[name]').each((i, elem) => {
        const src = $(elem).attr('src');
        const name = $(elem).attr('name');
        
        if (src && name && src.includes('/manga/')) {
          const fullUrl = src.startsWith('http') ? src : `https://www.sailmg.com${src}`;
          images.push({
            index: parseInt(name) || images.length,
            src: src,
            name: name,
            source: 'img-tag-with-name',
            fullUrl: fullUrl
          });
        }
      });
    }

    // Method 3: Find images in script tags
    if (images.length === 0) {
      $('script').each((i, elem) => {
        const scriptContent = $(elem).html();
        if (scriptContent) {
          const arrayMatch = scriptContent.match(/\[[\s\S]*?\]/g);
          if (arrayMatch) {
            arrayMatch.forEach(arr => {
              const urlMatches = arr.match(/["'](https?:\/\/[^"']+?\/manga\/[^"']*?\.(?:jpg|jpeg|png|gif|webp)[^"']*)["']/gi);
              if (urlMatches) {
                urlMatches.forEach(match => {
                  const cleanUrl = match.replace(/['"]/g, '');
                  if (!images.find(img => img.fullUrl === cleanUrl)) {
                    images.push({
                      index: images.length,
                      src: cleanUrl,
                      source: 'script-array',
                      fullUrl: cleanUrl
                    });
                  }
                });
              }
            });
          }
        }
      });
    }

    images.forEach((img, idx) => {
      img.index = idx;
    });

    return images;
  } catch (error) {
    throw new Error(`Scraping failed: ${error.message}`);
  }
}

// Function to download image to buffer
async function downloadImageToBuffer(imageUrl) {
  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.sailmg.com/'
      },
      timeout: 30000
    });

    return response.data;
  } catch (error) {
    console.error(`Failed to download ${imageUrl}:`, error.message);
    return null;
  }
}

// Routes

// Provider info route
router.get('/', (req, res) => {
  res.json({
    provider: 'SailMG',
    version: '1.0.0',
    features: ['anilist-integration', 'pagination', 'batch-download'],
    endpoints: {
      'GET /chapters': '📚 Get chapter list with manual pagination',
      'GET /download': '🔥 Download chapter as ZIP',
      'GET /read': '📖 Read manga images (JSON response)',
      'GET /download-multiple': '📦 Download multiple chapters as ZIP',
      'GET /debug': '🔍 Get raw HTML for debugging',
      'GET /anilist': '🔍 Search AniList by title'
    },
    examples: {
      chaptersById: '/manga/sailmg/chapters?mangaId=125828&page=1',
      chaptersBySlug: '/manga/sailmg/chapters?mangaId=sakamoto-days&page=0',
      anilistSearch: '/manga/sailmg/anilist?title=sakamoto days',
      download: '/manga/sailmg/download?chapterId=sakamoto-days-186',
      read: '/manga/sailmg/read?chapterId=sakamoto-days-186',
      downloadMultiple: '/manga/sailmg/download-multiple?chapterIds=sakamoto-days-186,sakamoto-days-187&folderName=Sakamoto'
    }
  });
});

// Get chapter list - Manual pagination with AniList support
router.get('/chapters', async (req, res) => {
  const { mangaId, page = 0 } = req.query;
  
  if (!mangaId) {
    return res.status(400).json({ 
      error: 'mangaId parameter is required',
      examples: [
        '/manga/sailmg/chapters?mangaId=125828&page=1 (AniList ID with page)',
        '/manga/sailmg/chapters?mangaId=sakamoto-days&page=0 (slug with page)',
        '/manga/sailmg/chapters?mangaId=125828 (defaults to page 0)'
      ]
    });
  }

  try {
    let anilistData = null;
    let chapters = [];
    let usedSlug = null;
    let paginationInfo = null;
    
    const isAniListId = /^\d+$/.test(mangaId);
    const pageNum = parseInt(page);
    
    if (isAniListId) {
      console.log(`Fetching manga info from AniList ID: ${mangaId}`);
      anilistData = await getAniListManga(mangaId);
      
      if (!anilistData) {
        return res.status(404).json({
          success: false,
          error: 'Manga not found on AniList'
        });
      }
      
      const slugVariations = generateSlugVariations(anilistData);
      console.log(`Generated slug variations: ${slugVariations.join(', ')}`);
      
      usedSlug = await findWorkingSlug(slugVariations);
      
      if (!usedSlug) {
        return res.status(404).json({
          success: false,
          error: 'Could not find manga on sailmg.com with any slug variation',
          anilist: anilistData,
          triedSlugs: slugVariations
        });
      }
    } else {
      usedSlug = mangaId;
    }
    
    const baseUrl = getChapterUrl(usedSlug);
    const url = pageNum > 0 ? `${baseUrl}?page=${pageNum}` : baseUrl;
    
    console.log(`Scraping page ${pageNum} from: ${url}`);
    
    const result = await scrapeChaptersFromPage(url, usedSlug);
    chapters = result.chapters;
    paginationInfo = result.paginationInfo;
    
    res.json({
      success: true,
      provider: 'sailmg',
      anilist: anilistData,
      sailmg: {
        slug: usedSlug,
        currentPage: pageNum,
        chaptersOnPage: chapters.length,
        chapters: chapters,
        pagination: {
          hasNext: paginationInfo.hasNext,
          hasPrevious: paginationInfo.hasPrevious,
          nextPageUrl: paginationInfo.hasNext ? `/manga/sailmg/chapters?mangaId=${mangaId}&page=${pageNum + 1}` : null,
          previousPageUrl: paginationInfo.hasPrevious && pageNum > 0 ? `/manga/sailmg/chapters?mangaId=${mangaId}&page=${pageNum - 1}` : null
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Search AniList by title
router.get('/anilist', async (req, res) => {
  const { title } = req.query;
  
  if (!title) {
    return res.status(400).json({ 
      error: 'title parameter is required. Example: /manga/sailmg/anilist?title=sakamoto days' 
    });
  }

  try {
    const manga = await searchAniList(title);
    
    if (!manga) {
      return res.status(404).json({
        success: false,
        message: 'Manga not found on AniList'
      });
    }
    
    res.json({
      success: true,
      provider: 'sailmg',
      manga: manga,
      suggestedSlugs: generateSlugVariations(manga)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Download as ZIP file
router.get('/download', async (req, res) => {
  const { chapterId } = req.query;
  
  if (!chapterId) {
    return res.status(400).json({ 
      error: 'chapterId parameter is required. Example: /manga/sailmg/download?chapterId=sakamoto-days-186' 
    });
  }

  try {
    const targetUrl = getChapterUrl(chapterId);
    console.log(`Starting download for: ${targetUrl}`);
    const images = await scrapeMangaImages(targetUrl);
    
    if (images.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No images found. Try the /debug endpoint to see Drupal settings.'
      });
    }

    console.log(`Found ${images.length} images, creating ZIP...`);

    const zipFilename = `${chapterId}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });

    archive.pipe(res);

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const filename = `${chapterId}/page_${String(i + 1).padStart(3, '0')}${path.extname(img.fullUrl) || '.jpg'}`;
      
      console.log(`Downloading ${i + 1}/${images.length}: ${filename}`);
      
      const imageBuffer = await downloadImageToBuffer(img.fullUrl);
      
      if (imageBuffer) {
        archive.append(imageBuffer, { name: filename });
      } else {
        console.error(`Failed to download image ${i + 1}`);
      }

      await new Promise(resolve => setTimeout(resolve, 300));
    }

    await archive.finalize();
    console.log('ZIP download complete!');

  } catch (error) {
    console.error('Download error:', error);
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// Read manga images
router.get('/read', async (req, res) => {
  const { chapterId } = req.query;
  
  if (!chapterId) {
    return res.status(400).json({ 
      error: 'chapterId parameter is required. Example: /manga/sailmg/read?chapterId=sakamoto-days-186' 
    });
  }

  try {
    const targetUrl = getChapterUrl(chapterId);
    const images = await scrapeMangaImages(targetUrl);
    
    res.json({
      success: true,
      provider: 'sailmg',
      chapterId: chapterId,
      count: images.length,
      images: images,
      tip: images.length === 0 ? 'Try the /debug endpoint to see the raw HTML and Drupal settings' : null
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Download multiple chapters as ZIP file
router.get('/download-multiple', async (req, res) => {
  const { chapterIds, folderName } = req.query;
  
  if (!chapterIds) {
    return res.status(400).json({ 
      error: 'chapterIds parameter is required. Example: /manga/sailmg/download-multiple?chapterIds=sakamoto-days-186,sakamoto-days-187&folderName=Sakamoto' 
    });
  }

  try {
    const chapterList = chapterIds.split(',').map(id => id.trim()).filter(id => id);
    
    if (chapterList.length === 0) {
      return res.status(400).json({
        error: 'No valid chapter IDs provided'
      });
    }

    console.log(`Starting download for ${chapterList.length} chapters...`);

    const zipFilename = folderName ? `${folderName}.zip` : `chapters_${Date.now()}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    archive.on('error', (err) => {
      console.error('Archive error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });

    archive.pipe(res);

    const downloadSummary = [];

    for (let chapterIndex = 0; chapterIndex < chapterList.length; chapterIndex++) {
      const chapterId = chapterList[chapterIndex];
      const targetUrl = getChapterUrl(chapterId);
      
      console.log(`\n[${chapterIndex + 1}/${chapterList.length}] Processing chapter: ${chapterId}`);
      
      try {
        const images = await scrapeMangaImages(targetUrl);
        
        if (images.length === 0) {
          console.log(`No images found for ${chapterId}`);
          downloadSummary.push({
            chapterId,
            success: false,
            imagesDownloaded: 0,
            error: 'No images found'
          });
          continue;
        }

        console.log(`Found ${images.length} images for ${chapterId}`);
        
        let successCount = 0;
        
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          const filename = `${folderName || 'chapters'}/${chapterId}/page_${String(i + 1).padStart(3, '0')}${path.extname(img.fullUrl) || '.jpg'}`;
          
          console.log(`  Downloading ${i + 1}/${images.length}: ${filename}`);
          
          const imageBuffer = await downloadImageToBuffer(img.fullUrl);
          
          if (imageBuffer) {
            archive.append(imageBuffer, { name: filename });
            successCount++;
          } else {
            console.error(`  Failed to download image ${i + 1}`);
          }

          await new Promise(resolve => setTimeout(resolve, 300));
        }

        downloadSummary.push({
          chapterId,
          success: true,
          totalImages: images.length,
          imagesDownloaded: successCount,
          imagesFailed: images.length - successCount
        });

      } catch (error) {
        console.error(`Error processing ${chapterId}:`, error.message);
        downloadSummary.push({
          chapterId,
          success: false,
          error: error.message
        });
      }
    }

    await archive.finalize();
    
    const totalImages = downloadSummary.reduce((sum, chapter) => sum + (chapter.imagesDownloaded || 0), 0);
    console.log(`\n✅ ZIP download complete! Total images: ${totalImages}`);

  } catch (error) {
    console.error('Download error:', error);
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// Debug endpoint
router.get('/debug', async (req, res) => {
  const { chapterId } = req.query;
  
  if (!chapterId) {
    return res.status(400).json({ 
      error: 'chapterId parameter is required. Example: /manga/sailmg/debug?chapterId=sakamoto-days-186' 
    });
  }

  try {
    const targetUrl = getChapterUrl(chapterId);
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.sailmg.com/'
      }
    });

    const $ = cheerio.load(response.data);
    
    let drupalSettings = null;
    $('script').each((i, elem) => {
      const scriptContent = $(elem).html();
      if (scriptContent && scriptContent.includes('Drupal.settings')) {
        const drupalMatch = scriptContent.match(/jQuery\.extend\(Drupal\.settings,\s*({[\s\S]*?})\);/);
        if (drupalMatch) {
          try {
            drupalSettings = JSON.parse(drupalMatch[1]);
          } catch (e) {
            drupalSettings = { error: 'Failed to parse', raw: drupalMatch[1].substring(0, 500) };
          }
        }
      }
    });

    const imgTags = [];
    $('img').each((i, elem) => {
      imgTags.push({
        src: $(elem).attr('src'),
        name: $(elem).attr('name'),
        alt: $(elem).attr('alt'),
        class: $(elem).attr('class')
      });
    });

    res.json({
      success: true,
      provider: 'sailmg',
      chapterId: chapterId,
      url: targetUrl,
      htmlLength: response.data.length,
      drupalSettings: drupalSettings,
      mangaPaths: drupalSettings?.showmanga?.paths || null,
      imgTags: imgTags,
      scriptCount: $('script').length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;