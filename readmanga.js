const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');

const app = express();
const PORT = 3000;

// AniList API configuration
const ANILIST_API = 'https://graphql.anilist.co';

// Middleware
app.use(cors());
app.use(express.json());

// Root endpoint - display available endpoints
app.get('/', (req, res) => {
  res.json({
    message: 'Manga Scraper API',
    version: '1.0.0',
    port: PORT,
    endpoints: {
      health: {
        path: '/api/health',
        method: 'GET',
        description: 'Check API status'
      },
      chapters: {
        path: '/api/chapters/:manga',
        method: 'GET',
        description: 'Get all chapters from a manga',
        example: `http://localhost:${PORT}/api/chapters/25d-seduction`
      },
      readChapter: {
        path: '/api/read/:manga/:chapter',
        method: 'GET',
        description: 'Get all images from a chapter',
        example: `http://localhost:${PORT}/api/read/25d-seduction/chapter-196`
      },
      anilistChapters: {
        path: '/api/anilist-chapters/:anilistId',
        method: 'GET',
        description: 'Get manga info from AniList by ID (optionally include chapters with ?slug= parameter)',
        example: `http://localhost:${PORT}/api/anilist-chapters/110785?slug=25d-seduction`
      },
      anilistSearch: {
        path: '/api/anilist-search',
        method: 'GET',
        description: 'Search manga on AniList',
        example: `http://localhost:${PORT}/api/anilist-search?query=Blue Lock`
      },
      debug: {
        path: '/api/debug',
        method: 'GET',
        description: 'Debug HTML structure of a page',
        example: `http://localhost:${PORT}/api/debug?url=YOUR_URL`
      },
      download: {
        path: '/api/download',
        method: 'GET',
        description: 'Download a chapter as a ZIP file',
        example: `http://localhost:${PORT}/api/download?chapterId=25d-seduction/chapter-196`
      },
      downloadMultiple: {
        path: '/api/download-multiple-chapters',
        method: 'GET',
        description: 'Download multiple chapters as a single ZIP file',
        example: `http://localhost:${PORT}/api/download-multiple-chapters?chapterIds=25d-seduction/chapter-196,25d-seduction/chapter-195&folderName=2.5D Seduction`
      }
    }
  });
});


async function findMangaSlugOnSite(searchTitle) {
  try {
    // Try to search or browse the site to find the manga
    const searchUrl = `https://readmanga.cc/?s=${encodeURIComponent(searchTitle)}`;
    
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://readmanga.cc/'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    const results = [];
    
    // Find search results - adjust selectors based on actual site structure
    $('a[href*="/manga/"]').each((i, elem) => {
      const href = $(elem).attr('href');
      const title = $(elem).text().trim() || $(elem).find('h3, h4, h5').text().trim();
      
      if (href && href.includes('/manga/') && title) {
        const slug = href.replace(/.*\/manga\//, '').replace(/\/$/, '');
        
        // Avoid duplicates
        if (!results.some(r => r.slug === slug)) {
          results.push({
            slug: slug,
            title: title,
            url: href.startsWith('http') ? href : `https://readmanga.cc${href}`
          });
        }
      }
    });

    return results;
  } catch (error) {
    console.error(`Search failed for "${searchTitle}":`, error.message);
    return [];
  }
}

// Helper function to generate slug variations including with numbers
function generateSlugVariations(title) {
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
    baseSlug.replace(/-/g, ''),  // bluelock
    baseSlug.replace(/-/g, ' ').replace(/\s+/g, '-')  // normalize spaces
  ];
  
  return [...new Set(variations)]; // Remove duplicates
}
  

 // New endpoint: Get chapters by AniList ID (with all title variations)
app.get('/api/anilist-chapters/:anilistId', async (req, res) => {
  try {
    const targetAnilistId = parseInt(req.params.anilistId);
    
    // Fetch manga info from AniList to get ALL possible titles
    const query = `
      query ($id: Int) {
        Media(id: $id, type: MANGA) {
          id
          title {
            romaji
            english
            native
            userPreferred
          }
          synonyms
        }
      }
    `;

    const anilistResponse = await axios.post(ANILIST_API, {
      query: query,
      variables: { id: targetAnilistId }
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (anilistResponse.data.errors) {
      return res.status(400).json({
        success: false,
        error: 'Invalid AniList ID',
        details: anilistResponse.data.errors
      });
    }

    const media = anilistResponse.data.data.Media;
    
    // Get ALL title variations
    const allTitles = [
      media.title.english,
      media.title.romaji,
      media.title.native,
      media.title.userPreferred,
      ...(media.synonyms || [])
    ].filter(Boolean); // Remove null/undefined values
    
    // Create normalized versions for matching (lowercase, no special chars)
    const normalizedTitles = allTitles.map(t => 
      t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()
    );
    
    // Use the first available title as primary
    const primaryTitle = media.title.english || media.title.romaji || media.title.userPreferred || allTitles[0];
    
    console.log(`\nSearching for AniList ID ${targetAnilistId}:`);
    console.log(`Primary title: ${primaryTitle}`);
    console.log(`All titles (${allTitles.length}):`, allTitles);
    
    // Generate slug variations from ALL titles
    const allSlugVariations = [];
    
    for (const title of allTitles) {
      const variations = generateSlugVariations(title);
      allSlugVariations.push(...variations);
    }
    
    // Remove duplicates and limit to reasonable amount
    const uniqueSlugs = [...new Set(allSlugVariations)].slice(0, 50); // Limit to 50 to avoid too many requests
    
    console.log(`Testing ${uniqueSlugs.length} slug variations...`);
    
    let foundSlug = null;
    let matchMethod = null;
    let matchedTitle = null;

    // Test each slug variation
    for (const slug of uniqueSlugs) {
      try {
        const testUrl = `https://readmanga.cc/manga/${slug}`;
        
        const response = await axios.get(testUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': 'https://readmanga.cc/'
          },
          timeout: 10000,
          validateStatus: (status) => status === 200
        });

        const $ = cheerio.load(response.data);
        
        // Extract AniList ID from the page
        let pageAnilistId = null;
        
        $('a[href*="anilist.co"]').each((i, elem) => {
          const href = $(elem).attr('href');
          const match = href.match(/anilist\.co\/manga\/(\d+)/);
          if (match) {
            pageAnilistId = parseInt(match[1]);
            return false;
          }
        });

        if (!pageAnilistId) {
          $('meta, script, [data-anilist]').each((i, elem) => {
            const content = $(elem).attr('content') || $(elem).html() || $(elem).attr('data-anilist') || '';
            const match = content.match(/anilist\.co\/manga\/(\d+)/);
            if (match) {
              pageAnilistId = parseInt(match[1]);
              return false;
            }
          });
        }

        // Get the manga title from the page
        const pageMangaTitle = $('h1, .manga-title, .entry-title').first().text().trim();
        const normalizedPageTitle = pageMangaTitle.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

        // Priority 1: Check if AniList ID matches (most reliable)
        if (pageAnilistId === targetAnilistId) {
          foundSlug = slug;
          matchMethod = 'anilist_id';
          matchedTitle = pageMangaTitle;
          console.log(`✓ PERFECT MATCH by AniList ID: "${slug}" -> "${pageMangaTitle}"`);
          break;
        }

        // Priority 2: Check if title matches any of our titles (fallback)
        if (pageMangaTitle) {
          for (let i = 0; i < normalizedTitles.length; i++) {
            const searchTitle = normalizedTitles[i];
            
            // Check for exact match, contains, or is contained
            if (normalizedPageTitle === searchTitle || 
                normalizedPageTitle.includes(searchTitle) ||
                searchTitle.includes(normalizedPageTitle)) {
              
              foundSlug = slug;
              matchMethod = 'title_match';
              matchedTitle = pageMangaTitle;
              console.log(`✓ MATCH by title: "${slug}"`);
              console.log(`  Page title: "${pageMangaTitle}"`);
              console.log(`  Matched with: "${allTitles[i]}"`);
              break;
            }
          }
          
          if (foundSlug) break;
        }

        console.log(`✗ No match: "${slug}" -> "${pageMangaTitle}"`);

      } catch (err) {
        if (err.response?.status === 404) {
          console.log(`✗ 404: "${slug}"`);
        } else if (err.code === 'ECONNABORTED') {
          console.log(`✗ Timeout: "${slug}"`);
        } else {
          console.log(`✗ Error: "${slug}" - ${err.message}`);
        }
        continue;
      }
    }

    if (!foundSlug) {
      return res.status(404).json({
        success: false,
        error: 'Could not find manga on readmanga.cc',
        anilistId: targetAnilistId,
        searchedTitles: allTitles,
        triedSlugs: uniqueSlugs.slice(0, 20), // Show first 20 attempted slugs
        message: 'The manga might not be available on readmanga.cc, uses a very different title, or requires manual slug input'
      });
    }

    // Now fetch the chapter data using the verified slug
    const chaptersUrl = `https://readmanga.cc/manga/${foundSlug}`;
    
    const chaptersResponse = await axios.get(chaptersUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://readmanga.cc/'
      }
    });

    const $ = cheerio.load(chaptersResponse.data);
    const chapters = [];
    
    $('a[data-chapter]').each((i, elem) => {
      const $elem = $(elem);
      const chapterNumber = $elem.attr('data-chapter');
      const href = $elem.attr('href');
      const chapterTitle = $elem.find('h5').text().trim();
      const timeAgo = $elem.find('p').text().trim();
      
      const id = href.replace('https://readmanga.cc/read/', '').replace(/^\/read\//, '');
      
      chapters.push({
        id: id,
        chapterNumber: chapterNumber,
        title: chapterTitle,
        url: href.startsWith('http') ? href : `https://readmanga.cc${href}`,
        timeAgo: timeAgo
      });
    });

    const mangaTitle = $('h1, .manga-title, .entry-title').first().text().trim() || 'Unknown Manga';

    res.json({
      success: true,
      detectedSlug: foundSlug,
      matchMethod: matchMethod,
      matchedTitle: matchedTitle,
      manga: {
        mangaSlug: foundSlug,
        mangaId: foundSlug,
        mangaTitle: mangaTitle,
        url: chaptersUrl,
        chapters: chapters,
        totalChapters: chapters.length,
        scrapedChapterCount: chapters.length,
        anilistId: targetAnilistId,
        title: media.title,
        anilistUrl: `https://anilist.co/manga/${targetAnilistId}`
      }
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to fetch manga data from AniList ID'
    });
  }
});


app.get('/api/anilist-search', async (req, res) => {
  try {
    const searchQuery = req.query.query;
    
    if (!searchQuery) {
      return res.status(400).json({
        success: false,
        error: 'query parameter is required',
        example: '/api/anilist-search?query=Blue Lock'
      });
    }

    const query = `
      query ($search: String, $page: Int, $perPage: Int) {
        Page(page: $page, perPage: $perPage) {
          pageInfo {
            total
            currentPage
            lastPage
            hasNextPage
            perPage
          }
          media(search: $search, type: MANGA, sort: POPULARITY_DESC) {
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
            averageScore
            popularity
            status
            chapters
            volumes
            format
            startDate {
              year
              month
              day
            }
            siteUrl
          }
        }
      }
    `;

    const variables = {
      search: searchQuery,
      page: parseInt(req.query.page) || 1,
      perPage: parseInt(req.query.perPage) || 10
    };

    const response = await axios.post(ANILIST_API, {
      query: query,
      variables: variables
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    if (response.data.errors) {
      return res.status(400).json({
        success: false,
        error: 'AniList API error',
        details: response.data.errors
      });
    }

    const page = response.data.data.Page;

    const results = page.media.map(manga => {
      const cleanDescription = manga.description 
        ? manga.description.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim().substring(0, 200) + '...'
        : null;

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

    res.json({
      success: true,
      pageInfo: page.pageInfo,
      results: results
    });

  } catch (error) {
    console.error('AniList search error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to search manga on AniList'
    });
  }
});

// Debug endpoint to see raw HTML structure
app.get('/api/debug', async (req, res) => {
  try {
    const url = req.query.url || 'https://readmanga.cc/read/blue-lock-3/chapter-322';
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://readmanga.cc/'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Find all img tags
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

    // Find all divs that might contain images
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

    // Check for script tags with image data
    const scripts = [];
    $('script').each((i, elem) => {
      const content = $(elem).html();
      if (content && (content.includes('images') || content.includes('pages') || content.includes('.jpg') || content.includes('.png'))) {
        scripts.push({
          index: i,
          snippet: content.substring(0, 500)
        });
      }
    });

    res.json({
      success: true,
      url: url,
      allImages: allImages,
      imageDivs: imageDivs,
      scriptsWithImages: scripts,
      totalImgTags: allImages.length
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Read chapter endpoint with path parameters
app.get('/api/read/:manga/:chapter', async (req, res) => {
  try {
    const { manga, chapter } = req.params;
    const url = `https://readmanga.cc/read/${manga}/${chapter}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://readmanga.cc/'
      }
    });

    const $ = cheerio.load(response.data);
    const images = [];
    
    // Try multiple common selectors
    const selectors = [
      'img.page-img',
      'img.manga-page',
      '.reader-image img',
      '#reader img',
      '.reading-content img',
      '.page-break img',
      'div#readerarea img',
      'div.reading-content img',
      'img[data-src]',
      'img.lazyload',
      '.chapter-content img',
      'img[alt*="page"]',
      'img[src*=".jpg"], img[src*=".png"], img[src*=".webp"]'
    ];

    for (const selector of selectors) {
      $(selector).each((i, elem) => {
        const src = $(elem).attr('src') || 
                    $(elem).attr('data-src') || 
                    $(elem).attr('data-lazy-src') ||
                    $(elem).attr('data-original');
        
        if (src && !images.some(img => img.src === src)) {
          images.push({
            page: images.length + 1,
            src: src.startsWith('http') ? src : `https://readmanga.cc${src}`
          });
        }
      });
      
      if (images.length > 0) break;
    }

    // Check for JavaScript-embedded images
    if (images.length === 0) {
      $('script').each((i, elem) => {
        const scriptContent = $(elem).html();
        if (scriptContent) {
          // Look for image URLs in JavaScript
          const urlMatches = scriptContent.match(/https?:\/\/[^"'\s]+\.(jpg|jpeg|png|webp)/gi);
          if (urlMatches) {
            urlMatches.forEach((url, idx) => {
              if (!images.some(img => img.src === url)) {
                images.push({
                  page: images.length + 1,
                  src: url
                });
              }
            });
          }
        }
      });
    }

    const title = $('title').text() || 'No title found';
    const chapterTitle = $('.chapter-title, .reader-title, h1, .entry-title').first().text().trim() || 'Unknown Chapter';

    res.json({
      success: true,
      id: `${manga}/${chapter}`,
      url: url,
      title: title,
      chapterTitle: chapterTitle,
      totalPages: images.length,
      images: images
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to scrape manga page'
    });
  }
});

// Get chapters endpoint with path parameter
app.get('/api/chapters/:manga', async (req, res) => {
  try {
    const { manga } = req.params;
    const url = `https://readmanga.cc/manga/${manga}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://readmanga.cc/'
      }
    });

    const $ = cheerio.load(response.data);
    const chapters = [];
    
    // Find all chapter links based on the provided HTML structure
    $('a[data-chapter]').each((i, elem) => {
      const $elem = $(elem);
      const chapterNumber = $elem.attr('data-chapter');
      const href = $elem.attr('href');
      const title = $elem.find('h5').text().trim();
      const timeAgo = $elem.find('p').text().trim();
      
      // Extract the ID from the URL (e.g., "25d-seduction/chapter-196")
      const id = href.replace('https://readmanga.cc/read/', '').replace(/^\/read\//, '');
      
      chapters.push({
        id: id,
        chapterNumber: chapterNumber,
        title: title,
        url: href.startsWith('http') ? href : `https://readmanga.cc${href}`,
        timeAgo: timeAgo
      });
    });

    // Get manga title
    const mangaTitle = $('h1, .manga-title, .entry-title').first().text().trim() || 'Unknown Manga';

    res.json({
      success: true,
      mangaId: manga,
      url: url,
      mangaTitle: mangaTitle,
      totalChapters: chapters.length,
      chapters: chapters
    });

  } catch (error) {
    console.error('Chapter scraping error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to scrape chapter list'
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'Manga scraper API is running',
    endpoints: {
      read: '/api/read/25d-seduction/chapter-196',
      chapters: '/api/chapters/25d-seduction',
      anilistChapters: '/api/anilist-chapters/110785?slug=25d-seduction',
      anilistSearch: '/api/anilist-search?query=Blue Lock',
      debug: '/api/debug?url=YOUR_URL',
      download: '/api/download?chapterId=25d-seduction/chapter-196',
      downloadMultiple: '/api/download-multiple-chapters?chapterIds=25d-seduction/chapter-196,25d-seduction/chapter-195&folderName=2.5D Seduction',
      health: '/api/health'
    }
  });
});

// Download chapter as ZIP
app.get('/api/download', async (req, res) => {
  try {
    const chapterId = req.query.chapterId;
    
    if (!chapterId) {
      return res.status(400).json({
        success: false,
        error: 'chapterId parameter is required',
        example: '/api/download?chapterId=25d-seduction/chapter-196'
      });
    }

    const url = `https://readmanga.cc/read/${chapterId}`;
    
    // Fetch the chapter page
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://readmanga.cc/'
      }
    });

    const $ = cheerio.load(response.data);
    const images = [];
    
    // Try multiple common selectors
    const selectors = [
      'img.page-img',
      'img.manga-page',
      '.reader-image img',
      '#reader img',
      '.reading-content img',
      '.page-break img',
      'div#readerarea img',
      'div.reading-content img',
      'img[data-src]',
      'img.lazyload',
      '.chapter-content img',
      'img[alt*="page"]',
      'img[src*=".jpg"], img[src*=".png"], img[src*=".webp"]'
    ];

    for (const selector of selectors) {
      $(selector).each((i, elem) => {
        const src = $(elem).attr('src') || 
                    $(elem).attr('data-src') || 
                    $(elem).attr('data-lazy-src') ||
                    $(elem).attr('data-original');
        
        if (src && !images.some(img => img.src === src)) {
          images.push({
            page: images.length + 1,
            src: src.startsWith('http') ? src : `https://readmanga.cc${src}`
          });
        }
      });
      
      if (images.length > 0) break;
    }

    // Check for JavaScript-embedded images
    if (images.length === 0) {
      $('script').each((i, elem) => {
        const scriptContent = $(elem).html();
        if (scriptContent) {
          const urlMatches = scriptContent.match(/https?:\/\/[^"'\s]+\.(jpg|jpeg|png|webp)/gi);
          if (urlMatches) {
            urlMatches.forEach((url, idx) => {
              if (!images.some(img => img.src === url)) {
                images.push({
                  page: images.length + 1,
                  src: url
                });
              }
            });
          }
        }
      });
    }

    if (images.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No images found in the chapter'
      });
    }

    // Create ZIP archive
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    // Set response headers
    const sanitizedChapterId = chapterId.replace(/[^a-zA-Z0-9-]/g, '_');
    res.attachment(`${sanitizedChapterId}.zip`);
    res.setHeader('Content-Type', 'application/zip');

    // Pipe archive to response
    archive.pipe(res);

    // Download and add each image to the archive
    for (let i = 0; i < images.length; i++) {
      try {
        const imageResponse = await axios.get(images[i].src, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://readmanga.cc/'
          },
          timeout: 30000
        });

        // Get file extension from URL or content-type
        const contentType = imageResponse.headers['content-type'];
        let extension = 'jpg';
        if (contentType) {
          if (contentType.includes('png')) extension = 'png';
          else if (contentType.includes('webp')) extension = 'webp';
          else if (contentType.includes('jpeg')) extension = 'jpg';
        } else {
          const urlExt = images[i].src.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
          if (urlExt) extension = urlExt[1];
        }

        // Add image to archive with padded page number
        const pageNumber = String(i + 1).padStart(3, '0');
        archive.append(Buffer.from(imageResponse.data), { 
          name: `page_${pageNumber}.${extension}` 
        });

      } catch (imageError) {
        console.error(`Failed to download image ${i + 1}:`, imageError.message);
        // Continue with other images even if one fails
      }
    }

    // Finalize the archive
    await archive.finalize();

  } catch (error) {
    console.error('Download error:', error.message);
    
    // Only send error JSON if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message,
        message: 'Failed to create chapter download'
      });
    }
  }
});

// Download multiple chapters as a single ZIP
app.get('/api/download-multiple-chapters', async (req, res) => {
  try {
    const chapterIdsParam = req.query.chapterIds;
    const folderName = req.query.folderName || 'Manga Chapters';
    
    if (!chapterIdsParam) {
      return res.status(400).json({
        success: false,
        error: 'chapterIds parameter is required',
        example: '/api/download-multiple-chapters?chapterIds=25d-seduction/chapter-196,25d-seduction/chapter-195&folderName=2.5D Seduction'
      });
    }

    // Parse chapter IDs from comma-separated string
    const chapterIds = chapterIdsParam.split(',').map(id => id.trim()).filter(id => id);
    
    if (chapterIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid chapter IDs provided'
      });
    }

    // Create ZIP archive
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    // Set response headers
    const sanitizedFolderName = folderName.replace(/[^a-zA-Z0-9-_ ]/g, '_');
    res.attachment(`${sanitizedFolderName}.zip`);
    res.setHeader('Content-Type', 'application/zip');

    // Pipe archive to response
    archive.pipe(res);

    // Process each chapter
    for (const chapterId of chapterIds) {
      try {
        const url = `https://readmanga.cc/read/${chapterId}`;
        
        // Fetch the chapter page
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': 'https://readmanga.cc/'
          }
        });

        const $ = cheerio.load(response.data);
        const images = [];
        
        // Try multiple common selectors
        const selectors = [
          'img.page-img',
          'img.manga-page',
          '.reader-image img',
          '#reader img',
          '.reading-content img',
          '.page-break img',
          'div#readerarea img',
          'div.reading-content img',
          'img[data-src]',
          'img.lazyload',
          '.chapter-content img',
          'img[alt*="page"]',
          'img[src*=".jpg"], img[src*=".png"], img[src*=".webp"]'
        ];

        for (const selector of selectors) {
          $(selector).each((i, elem) => {
            const src = $(elem).attr('src') || 
                        $(elem).attr('data-src') || 
                        $(elem).attr('data-lazy-src') ||
                        $(elem).attr('data-original');
            
            if (src && !images.some(img => img.src === src)) {
              images.push({
                page: images.length + 1,
                src: src.startsWith('http') ? src : `https://readmanga.cc${src}`
              });
            }
          });
          
          if (images.length > 0) break;
        }

        // Check for JavaScript-embedded images
        if (images.length === 0) {
          $('script').each((i, elem) => {
            const scriptContent = $(elem).html();
            if (scriptContent) {
              const urlMatches = scriptContent.match(/https?:\/\/[^"'\s]+\.(jpg|jpeg|png|webp)/gi);
              if (urlMatches) {
                urlMatches.forEach((url, idx) => {
                  if (!images.some(img => img.src === url)) {
                    images.push({
                      page: images.length + 1,
                      src: url
                    });
                  }
                });
              }
            }
          });
        }

        if (images.length === 0) {
          console.warn(`No images found for chapter: ${chapterId}`);
          continue;
        }

        // Create a folder name for this chapter
        const chapterFolderName = chapterId.replace(/[^a-zA-Z0-9-]/g, '_');

        // Download and add each image to the archive
        for (let i = 0; i < images.length; i++) {
          try {
            const imageResponse = await axios.get(images[i].src, {
              responseType: 'arraybuffer',
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://readmanga.cc/'
              },
              timeout: 30000
            });

            // Get file extension from URL or content-type
            const contentType = imageResponse.headers['content-type'];
            let extension = 'jpg';
            if (contentType) {
              if (contentType.includes('png')) extension = 'png';
              else if (contentType.includes('webp')) extension = 'webp';
              else if (contentType.includes('jpeg')) extension = 'jpg';
            } else {
              const urlExt = images[i].src.match(/\.(jpg|jpeg|png|webp)(\?|$)/i);
              if (urlExt) extension = urlExt[1];
            }

            // Add image to archive with folder structure
            const pageNumber = String(i + 1).padStart(3, '0');
            archive.append(Buffer.from(imageResponse.data), { 
              name: `${chapterFolderName}/page_${pageNumber}.${extension}` 
            });

          } catch (imageError) {
            console.error(`Failed to download image ${i + 1} from ${chapterId}:`, imageError.message);
            // Continue with other images even if one fails
          }
        }

        console.log(`Successfully processed chapter: ${chapterId} (${images.length} images)`);

      } catch (chapterError) {
        console.error(`Failed to process chapter ${chapterId}:`, chapterError.message);
        // Continue with other chapters even if one fails
      }
    }

    // Finalize the archive
    await archive.finalize();

  } catch (error) {
    console.error('Multiple download error:', error.message);
    
    // Only send error JSON if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message,
        message: 'Failed to create multiple chapters download'
      });
    }
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`\nAvailable endpoints:`);
  console.log(`- Root: http://localhost:${PORT}/`);
  console.log(`- Health: http://localhost:${PORT}/api/health`);
  console.log(`- Read chapter: http://localhost:${PORT}/api/read/:manga/:chapter`);
  console.log(`- Get chapters: http://localhost:${PORT}/api/chapters/:manga`);
  console.log(`- AniList by ID: http://localhost:${PORT}/api/anilist-chapters/:anilistId`);
  console.log(`- AniList search: http://localhost:${PORT}/api/anilist-search?query=YOUR_QUERY`);
  console.log(`- Download chapter: http://localhost:${PORT}/api/download?chapterId=:manga/:chapter`);
  console.log(`- Download multiple: http://localhost:${PORT}/api/download-multiple-chapters?chapterIds=...&folderName=...`);
  console.log(`- Debug: http://localhost:${PORT}/api/debug?url=YOUR_URL`);
});
 
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});