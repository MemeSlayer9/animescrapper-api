const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { request, gql } = require('graphql-request');
const archiver = require('archiver');
const path = require('path');

const app = express();
const PORT = 3000;
const ANILIST_API = 'https://graphql.anilist.co';

app.use(cors());
app.use(express.json());

// AniList GraphQL Query
const SEARCH_MANGA_QUERY = gql`
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

// AniList search function
async function searchAniList(mangaTitle) {
  try {
    const data = await request(ANILIST_API, SEARCH_MANGA_QUERY, { 
      search: mangaTitle 
    });
    return data.Media;
  } catch (error) {
    console.error('Error fetching from AniList:', error);
    return null;
  }
}

// Debug endpoint
app.get('/api/debug/:mangaId/:chapterId', async (req, res) => {
  try {
    const { mangaId, chapterId } = req.params;
    const url = `https://mangabuddy.com/${mangaId}/${chapterId}`;

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Get all img tags
    const allImages = [];
    $('img').each((i, elem) => {
      allImages.push({
        src: $(elem).attr('src'),
        'data-src': $(elem).attr('data-src'),
        'data-lazy': $(elem).attr('data-lazy'),
        'data-original': $(elem).attr('data-original'),
        alt: $(elem).attr('alt'),
        class: $(elem).attr('class'),
        id: $(elem).attr('id')
      });
    });

    // Get all scripts containing image data
    const scripts = [];
    $('script').each((i, elem) => {
      const content = $(elem).html();
      if (content && (content.includes('image') || content.includes('page') || content.includes('chapter'))) {
        scripts.push(content.substring(0, 500));
      }
    });

    // Get all scripts content for debugging
    const allScripts = [];
    $('script').each((i, elem) => {
      const content = $(elem).html();
      if (content && (content.includes('image') || content.includes('mbcdns') || content.includes('chapter'))) {
        allScripts.push({
          index: i,
          snippet: content.substring(0, 1000),
          length: content.length
        });
      }
    });

    res.json({
      url: url,
      totalImages: allImages.length,
      images: allImages,
      scriptSnippets: scripts,
      scriptsWithImageData: allScripts,
      bodySnippet: $('body').html().substring(0, 2000)
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Main scraper - with path parameters
app.get('/api/scrape/chapter/:mangaId/:chapterId', async (req, res) => {
  try {
    const { mangaId, chapterId } = req.params;
    const url = `https://mangabuddy.com/${mangaId}/${chapterId}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://mangabuddy.com/'
      }
    });

    const $ = cheerio.load(response.data);
    const chapterTitle = $('h1').first().text().trim() || 'Chapter';

    // Extract images
    const imageUrls = new Set();
    
    // Method 1: Get visible images first
    $('img').each((i, elem) => {
      const $elem = $(elem);
      const src = $elem.attr('src') || $elem.attr('data-src') || $elem.attr('data-original');
      if (src && src.includes('mbcdns')) {
        imageUrls.add(src);
      }
    });

    // Method 2: Extract ALL mbcdns URLs from all script tags
    $('script').each((i, elem) => {
      const scriptText = $(elem).html() || '';
      if (!scriptText) return;
      
      // Find all URLs that match the pattern
      const regex = /https?:\/\/s\d+\.mbcdns[a-z]+\.org\/[^\s"',]+\.(?:jpg|jpeg|png|webp)/gi;
      const matches = scriptText.match(regex);
      
      if (matches) {
        matches.forEach(url => {
          let cleanUrl = url.replace(/[\\",;)\]]+$/, '');
          imageUrls.add(cleanUrl);
        });
      }
    });

    // Convert Set to Array and create page objects
    const pages = Array.from(imageUrls).map((url, index) => ({
      page: index + 1,
      imageUrl: url,
      alt: `Page ${index + 1}`
    }));

    // Sort by CDN subdomain number (s1, s2, s3, etc)
    pages.sort((a, b) => {
      const aMatch = a.imageUrl.match(/s(\d+)\./);
      const bMatch = b.imageUrl.match(/s(\d+)\./);
      const aNum = aMatch ? parseInt(aMatch[1]) : 0;
      const bNum = bMatch ? parseInt(bMatch[1]) : 0;
      return aNum - bNum;
    });

    // Renumber after sorting
    pages.forEach((page, index) => {
      page.page = index + 1;
      page.alt = `Page ${index + 1}`;
    });

    res.json({
      success: true,
      data: {
        title: chapterTitle,
        url: url,
        mangaId: mangaId,
        chapterId: chapterId,
        totalPages: pages.length,
        pages: pages.map(p => ({
          ...p,
          proxiedUrl: `http://localhost:${PORT}/api/image-proxy?url=${encodeURIComponent(p.imageUrl)}`
        })),
        note: pages.length === 0 ? 'No images found.' : 'All images found!'
      }
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Scrape manga details and chapter list WITH AniList integration
app.get('/api/scrape/manga/:mangaId', async (req, res) => {
  try {
    const { mangaId } = req.params;
    const url = `https://mangabuddy.com/${mangaId}`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const $ = cheerio.load(response.data);
    
    // Extract manga info from MangaBuddy
    const title = $('h1').first().text().trim() || $('.manga-title').text().trim();
    const description = $('.summary').text().trim() || $('.description').text().trim();
    const cover = $('img.manga-cover').attr('src') || $('.manga-image img').attr('src');
    
    // Extract chapters
    const chapters = [];
    $('#chapter-list li, .chapter-list li').each((i, elem) => {
      const $elem = $(elem);
      const $link = $elem.find('a');
      const href = $link.attr('href');
      const chapterTitle = $link.find('.chapter-title, strong').text().trim();
      const date = $link.find('.chapter-update, time').text().trim();
      
      if (href && chapterTitle) {
        // Extract chapterId from URL
        let chapterId = '';
        try {
          const urlObj = new URL(href.startsWith('http') ? href : `https://mangabuddy.com${href}`);
          chapterId = urlObj.pathname.substring(1);
        } catch (e) {
          chapterId = href.replace(/^\//, '').replace(/^https?:\/\/mangabuddy\.com\//, '');
        }
        
        chapters.push({
          title: chapterTitle,
          url: href.startsWith('http') ? href : `https://mangabuddy.com${href}`,
          date: date || null,
          chapterId: chapterId
        });
      }
    });

    // Fetch AniList data
    let aniListData = null;
    if (title) {
      console.log(`Searching AniList for: ${title}`);
      aniListData = await searchAniList(title);
    }

    // Prepare response with combined data
    const responseData = {
      success: true,
      data: {
        // MangaBuddy data
        mangaBuddy: {
          title: title,
          description: description,
          cover: cover,
          mangaId: mangaId,
          url: url,
          totalChapters: chapters.length,
          chapters: chapters
        },
        // AniList data (if found)
        aniList: aniListData ? {
          id: aniListData.id,
          title: aniListData.title,
          description: aniListData.description,
          coverImage: aniListData.coverImage,
          bannerImage: aniListData.bannerImage,
          genres: aniListData.genres,
          tags: aniListData.tags?.map(t => t.name) || [],
          averageScore: aniListData.averageScore,
          popularity: aniListData.popularity,
          status: aniListData.status,
          chapters: aniListData.chapters,
          volumes: aniListData.volumes,
          startDate: aniListData.startDate,
          endDate: aniListData.endDate,
          synonyms: aniListData.synonyms,
          siteUrl: aniListData.siteUrl
        } : null
      }
    };

    res.json(responseData);

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// AniList Query by ID
const GET_MANGA_BY_ID_QUERY = gql`
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
        rank
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
      staff {
        edges {
          role
          node {
            name {
              full
            }
          }
        }
      }
    }
  }
`;

// Function to get manga by AniList ID
async function getMangaById(anilistId) {
  try {
    const data = await request(ANILIST_API, GET_MANGA_BY_ID_QUERY, { 
      id: parseInt(anilistId)
    });
    return data.Media;
  } catch (error) {
    console.error('Error fetching from AniList by ID:', error);
    return null;
  }
}

// New endpoint: Search AniList directly
app.get('/api/anilist/search', async (req, res) => {
  try {
    const { title } = req.query;
    
    if (!title) {
      return res.status(400).json({ 
        success: false,
        error: 'Title parameter required' 
      });
    }

    const aniListData = await searchAniList(title);
    
    if (!aniListData) {
      return res.json({
        success: false,
        message: 'No results found'
      });
    }

    res.json({
      success: true,
      data: aniListData
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Helper function to search MangaBuddy by title
async function searchMangaBuddyByTitle(title) {
  try {
    // Clean the title for URL (lowercase, replace spaces with hyphens)
    const searchSlug = title.toLowerCase()
      .replace(/[^\w\s-]/g, '') // Remove special chars
      .replace(/\s+/g, '-')      // Replace spaces with hyphens
      .replace(/-+/g, '-')       // Replace multiple hyphens with single
      .trim();

    console.log(`Attempting to fetch MangaBuddy: ${searchSlug}`);
    
    const url = `https://mangabuddy.com/${searchSlug}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    
    // Extract chapters
    const chapters = [];
    $('#chapter-list li, .chapter-list li, .chapter-item').each((i, elem) => {
      const $elem = $(elem);
      const $link = $elem.find('a');
      const href = $link.attr('href');
      const chapterTitle = $link.find('.chapter-title, strong, .chap-name').text().trim() || $link.text().trim();
      const date = $elem.find('.chapter-update, time, .chapter-time').text().trim();
      
      if (href && chapterTitle) {
        let chapterId = '';
        try {
          const urlObj = new URL(href.startsWith('http') ? href : `https://mangabuddy.com${href}`);
          chapterId = urlObj.pathname.substring(1);
        } catch (e) {
          chapterId = href.replace(/^\//, '').replace(/^https?:\/\/mangabuddy\.com\//, '');
        }
        
        chapters.push({
          title: chapterTitle,
          url: href.startsWith('http') ? href : `https://mangabuddy.com${href}`,
          date: date || null,
          chapterId: chapterId
        });
      }
    });

    if (chapters.length > 0) {
      return {
        found: true,
        mangaSlug: searchSlug,
        totalChapters: chapters.length,
        chapters: chapters
      };
    }
    
    return { found: false };
  } catch (error) {
    console.error(`MangaBuddy search failed: ${error.message}`);
    return { found: false };
  }
}

// New endpoint: Get manga by AniList ID with MangaBuddy chapters
app.get('/api/anilist/:anilistId', async (req, res) => {
  try {
    const { anilistId } = req.params;
    
    // Fetch AniList data
    const aniListData = await getMangaById(anilistId);
    
    if (!aniListData) {
      return res.status(404).json({
        success: false,
        message: 'Manga not found on AniList'
      });
    }

    // Try to find on MangaBuddy using the title
    let mangaBuddyData = null;
    const titleToSearch = aniListData.title.english || aniListData.title.romaji;
    
    if (titleToSearch) {
      console.log(`Searching MangaBuddy for: ${titleToSearch}`);
      mangaBuddyData = await searchMangaBuddyByTitle(titleToSearch);
      
      if (!mangaBuddyData.found) {
        console.log('Not found, trying romaji title...');
        mangaBuddyData = await searchMangaBuddyByTitle(aniListData.title.romaji);
      }
    }

    res.json({
      success: true,
      data: {
        aniList: aniListData,
        mangaBuddy: mangaBuddyData.found ? mangaBuddyData : null
      }
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Download chapter as ZIP
app.get('/api/download/chapter/:mangaId/:chapterId', async (req, res) => {
  try {
    const { mangaId, chapterId } = req.params;
    
    console.log(`Starting download for: ${mangaId}/${chapterId}`);
    
    // First, scrape the chapter to get all image URLs
    const scrapeUrl = `http://localhost:${PORT}/api/scrape/chapter/${mangaId}/${chapterId}`;
    const scrapeResponse = await axios.get(scrapeUrl);
    
    if (!scrapeResponse.data.success || !scrapeResponse.data.data.pages) {
      return res.status(404).json({
        success: false,
        error: 'Chapter not found or no pages available'
      });
    }

    const chapterData = scrapeResponse.data.data;
    const pages = chapterData.pages;
    
    console.log(`Found ${pages.length} pages to download`);

    // Set response headers for ZIP download
    const zipFilename = `${mangaId}_${chapterId}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    // Create ZIP archive
    const archive = archiver('zip', {
      zlib: { level: 9 } // Maximum compression
    });

    // Pipe archive to response
    archive.pipe(res);

    // Download and add each image to the ZIP
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      console.log(`Downloading page ${page.page}/${pages.length}...`);

      try {
        // Use the original image URL (not proxied)
        const imageResponse = await axios.get(page.imageUrl, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://mangabuddy.com/',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
          },
          timeout: 30000
        });

        // Get file extension from URL or content-type
        const urlExt = path.extname(page.imageUrl).split('?')[0] || '.jpg';
        const ext = urlExt || '.jpg';
        
        // Add image to ZIP with padded page number
        const paddedPageNum = String(page.page).padStart(3, '0');
        const filename = `page_${paddedPageNum}${ext}`;
        
        archive.append(Buffer.from(imageResponse.data), { name: filename });
        
        console.log(`✓ Added ${filename}`);
      } catch (imgError) {
        console.error(`Failed to download page ${page.page}:`, imgError.message);
        // Continue with other pages even if one fails
      }
    }

    // Add a metadata file
    const metadata = {
      manga: chapterData.mangaId,
      chapter: chapterData.chapterId,
      title: chapterData.title,
      totalPages: chapterData.totalPages,
      downloadedAt: new Date().toISOString(),
      source: chapterData.url
    };
    
    archive.append(JSON.stringify(metadata, null, 2), { name: 'info.json' });

    // Finalize the archive
    await archive.finalize();
    console.log(`✓ ZIP created successfully: ${zipFilename}`);

  } catch (error) {
    console.error('Download error:', error.message);
    
    // If headers haven't been sent yet, send error response
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// Download multiple chapters as organized ZIP - FIXED VERSION
app.get('/api/download-multiple/chapters', async (req, res) => {
  try {
    const { chapters, folderName } = req.query;
    
    if (!chapters) {
      return res.status(400).json({
        success: false,
        error: 'Chapters parameter required. Use ?chapters=manga/chapter1,manga/chapter2'
      });
    }
    
    // Parse chapters: "mangaId/chapterId,mangaId/chapterId,..."
    const chapterList = chapters.split(',').map(c => c.trim());
    
    console.log(`Starting bulk download for ${chapterList.length} chapters`);
    
    if (chapterList.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No chapters specified'
      });
    }

    // Set response headers for ZIP download
    const zipFilename = folderName ? `${folderName}.zip` : 'manga_chapters.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    // Create ZIP archive
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    // Handle archive errors
    archive.on('error', (err) => {
      console.error('Archive error:', err);
      throw err;
    });

    // Pipe archive to response
    archive.pipe(res);

    // Download each chapter
    for (let chapterIndex = 0; chapterIndex < chapterList.length; chapterIndex++) {
      const chapterPath = chapterList[chapterIndex];
      console.log(`\n[${chapterIndex + 1}/${chapterList.length}] Processing: ${chapterPath}`);

      try {
        // Scrape the chapter
        const scrapeUrl = `http://localhost:${PORT}/api/scrape/chapter/${chapterPath}`;
        const scrapeResponse = await axios.get(scrapeUrl);

        if (!scrapeResponse.data.success || !scrapeResponse.data.data.pages) {
          console.error(`⚠️  Skipping ${chapterPath} - not found`);
          continue;
        }

        const chapterData = scrapeResponse.data.data;
        const pages = chapterData.pages;
        
        // Create folder name for this chapter
        const chapterFolderName = chapterData.chapterId.replace(/\//g, '-');
        
        console.log(`  Found ${pages.length} pages`);

        // Download and add each page
        for (let i = 0; i < pages.length; i++) {
          const page = pages[i];
          
          try {
            const imageResponse = await axios.get(page.imageUrl, {
              responseType: 'arraybuffer',
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://mangabuddy.com/',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
              },
              timeout: 30000
            });

            // Get file extension
            const urlExt = path.extname(page.imageUrl).split('?')[0] || '.jpg';
            const ext = urlExt || '.jpg';
            
            // Create filename with padded page number
            const paddedPageNum = String(page.page).padStart(3, '0');
            const filename = `${chapterFolderName}/page_${paddedPageNum}${ext}`;
            
            archive.append(Buffer.from(imageResponse.data), { name: filename });
            
            // Log progress every 5 pages
            if ((i + 1) % 5 === 0 || i === pages.length - 1) {
              console.log(`  Progress: ${i + 1}/${pages.length} pages`);
            }
          } catch (imgError) {
            console.error(`  ⚠️  Failed to download page ${page.page}:`, imgError.message);
          }
        }

        // Add metadata for this chapter
        const metadata = {
          manga: chapterData.mangaId,
          chapter: chapterData.chapterId,
          title: chapterData.title,
          totalPages: chapterData.totalPages,
          downloadedAt: new Date().toISOString(),
          source: chapterData.url
        };
        
        archive.append(JSON.stringify(metadata, null, 2), { 
          name: `${chapterFolderName}/info.json` 
        });

        console.log(`  ✓ Completed ${chapterFolderName}`);

      } catch (chapterError) {
        console.error(`⚠️  Error processing ${chapterPath}:`, chapterError.message);
      }
    }

    // Add main metadata file
    const mainMetadata = {
      downloadedAt: new Date().toISOString(),
      totalChapters: chapterList.length,
      chapters: chapterList
    };
    archive.append(JSON.stringify(mainMetadata, null, 2), { name: 'download_info.json' });

    // Finalize the archive
    await archive.finalize();
    console.log(`\n✓ ZIP created successfully: ${zipFilename}`);

  } catch (error) {
    console.error('Bulk download error:', error.message);
    
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// Image proxy endpoint - bypasses CORS
app.get('/api/image-proxy', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }

    // Validate it's a manga image URL
    if (!url.includes('mbcdns')) {
      return res.status(403).json({ error: 'Only MangaBuddy images allowed' });
    }

    console.log(`Proxying image: ${url}`);

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://mangabuddy.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      timeout: 30000
    });

    // Get content type from response
    const contentType = response.headers['content-type'] || 'image/jpeg';
    
    // Set appropriate headers
    res.set({
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });

    // Send the image
    res.send(Buffer.from(response.data));

  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch image',
      message: error.message 
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Manga Scraper API with AniList Integration',
    endpoints: {
      debug: '/api/debug/:mangaId/:chapterId',
      scrapeChapter: '/api/scrape/chapter/:mangaId/:chapterId',
      downloadChapter: '/api/download/chapter/:mangaId/:chapterId',
      downloadMultiple: '/api/download-multiple/chapters?chapters=CHAPTER_PATHS&folderName=NAME',
      scrapeManga: '/api/scrape/manga/:mangaId (includes AniList data)',
      anilistSearch: '/api/anilist/search?title=MANGA_TITLE',
      anilistById: '/api/anilist/:anilistId',
      imageProxy: '/api/image-proxy?url=IMAGE_URL'
    },
    examples: {
      debug: '/api/debug/clevatess-the-king-of-devil-beasts-the-baby-and-the-brave-of-the-undead/chapter-58',
      scrapeChapter: '/api/scrape/chapter/clevatess-the-king-of-devil-beasts-the-baby-and-the-brave-of-the-undead/chapter-58',
      downloadChapter: '/api/download/chapter/sakamoto-days/chapter-238',
      downloadMultiple: '/api/download-multiple/chapters?chapters=sakamoto-days/chapter-238,sakamoto-days/chapter-237&folderName=Sakamoto-Days',
      scrapeManga: '/api/scrape/manga/jujutsu-kaisen',
      anilistSearch: '/api/anilist/search?title=jujutsu%20kaisen',
      anilistById: '/api/anilist/125828'
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📖 Manga Scraper: http://localhost:${PORT}/api/scrape/manga/jujutsu-kaisen`);
  console.log(`🔍 AniList Search: http://localhost:${PORT}/api/anilist/search?title=jujutsu%20kaisen`);
});