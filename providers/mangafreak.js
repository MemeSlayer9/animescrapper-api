const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const archiver = require('archiver');
const { request, gql } = require('graphql-request');

const router = express.Router();

// AniList API Configuration
const ANILIST_API = 'https://graphql.anilist.co';

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

// Get manga info from AniList by ID with MangaFreak chapters
router.get('/anilist/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id || isNaN(id)) {
      return res.status(400).json({ 
        success: false,
        error: 'Valid AniList manga ID is required',
        example: '/manga/mangafreak/anilist/105778'
      });
    }

    // Fetch AniList data
    const variables = { id: parseInt(id) };
    const data = await request(ANILIST_API, SEARCH_MANGA_BY_ID, variables);

    if (!data || !data.Media) {
      return res.status(404).json({
        success: false,
        error: 'Manga not found on AniList'
      });
    }

    // Try to find MangaFreak series name from AniList title
    let chapters = [];
    let source = 'AniList';
    
    // Use English title or Romaji title to search MangaFreak
    const anilistTitle = data.Media.title.english || data.Media.title.romaji || data.Media.title.native || data.Media.title.userPreferred;
    if (anilistTitle) {
      // Convert title to MangaFreak format (replace spaces with underscores)
      const seriesName = anilistTitle.replace(/\s+/g, '_');
      
      try {
        const mangaFreakUrl = `https://ww2.mangafreak.me/Manga/${seriesName}`;
        const mangaResponse = await axios.get(mangaFreakUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': 'https://ww2.mangafreak.me/',
            'Origin': 'https://ww2.mangafreak.me'
          },
          timeout: 30000
        });

        const $ = cheerio.load(mangaResponse.data);
        
        $('table tbody tr').each((i, elem) => {
          const $row = $(elem);
          const $link = $row.find('td:first-child a');
          
          if ($link.length > 0) {
            const chapterUrl = $link.attr('href');
            const chapterText = $link.text().trim();
            const dateText = $row.find('td:nth-child(2)').text().trim();
            
            const chapterMatch = chapterText.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
            const chapterNumber = chapterMatch ? chapterMatch[1] : '';
            
            const fullUrl = chapterUrl.startsWith('http') 
              ? chapterUrl 
              : `https://ww2.mangafreak.me${chapterUrl}`;
            
            const seriesMatch = chapterUrl.match(/Read1_([^_]+(?:_[^_]+)*)_\d+/);
            const series = seriesMatch ? seriesMatch[1] : '';
            const chapterId = series && chapterNumber ? `${series}/${chapterNumber}` : '';
            
            chapters.push({
              chapterId,
              chapterNumber,
              chapterText,
              url: fullUrl,
              releaseDate: dateText
            });
          }
        });

        if (chapters.length > 0) {
          chapters = chapters.reverse(); // Newest first
          source = 'AniList + MangaFreak';
        }
      } catch (mangaError) {
        console.error('Failed to fetch MangaFreak chapters:', mangaError.message);
      }
    }

    res.json({
      success: true,
      source: source,
      manga: data.Media,
      chapters: chapters,
      totalChapters: chapters.length
    });

  } catch (error) {
    console.error('AniList API error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch manga from AniList',
      details: error.message
    });
  }
});

// Search manga on AniList by title
router.get('/anilist-search/:title', async (req, res) => {
  try {
    const { title } = req.params;
    
    if (!title) {
      return res.status(400).json({ 
        success: false,
        error: 'Search title is required',
        example: '/manga/mangafreak/anilist-search/Chainsaw Man'
      });
    }

    const variables = { search: title };
    const data = await request(ANILIST_API, SEARCH_MANGA_BY_TITLE, variables);

    if (!data || !data.Media) {
      return res.status(404).json({
        success: false,
        error: 'Manga not found on AniList'
      });
    }

    res.json({
      success: true,
      source: 'AniList',
      manga: data.Media
    });

  } catch (error) {
    console.error('AniList search error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to search manga on AniList',
      details: error.message
    });
  }
});

// Custom proxy middleware for bypassing restrictions
router.get('/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ 
        success: false,
        error: 'URL parameter is required' 
      });
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
    console.error('MangaFreak proxy error:', error.message);
    res.status(500).json({ 
      success: false,
      error: 'Failed to proxy request',
      details: error.message 
    });
  }
});

// Scrape manga chapter images
router.get('/scrape-chapter', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ 
        success: false,
        error: 'URL parameter is required',
        example: '/manga/mangafreak/scrape-chapter?url=https://ww2.mangafreak.me/Read1_Chainsaw_Man_218'
      });
    }

    // Fetch the page
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
        const proxiedSrc = `${baseUrl}/manga/mangafreak/proxy?url=${encodeURIComponent(src)}`;
        
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
    console.error('MangaFreak scraping error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to scrape manga chapter',
      details: error.message
    });
  }
});

// Get specific manga chapter by series and chapter number
router.get('/read/:series/:chapter', async (req, res) => {
  try {
    const { series, chapter } = req.params;
    // Example: http://localhost:3000/manga/mangafreak/read/Chainsaw_Man/218
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
        const proxiedSrc = `${baseUrl}/manga/mangafreak/proxy?url=${encodeURIComponent(src)}`;
        
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
    console.error('MangaFreak read error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch manga chapter',
      details: error.message
    });
  }
});

// Get manga info by series name
router.get('/manga-info/:seriesName', async (req, res) => {
  try {
    const { seriesName } = req.params;
    
    if (!seriesName) {
      return res.status(400).json({ 
        success: false,
        error: 'Series name parameter is required',
        example: '/manga/mangafreak/manga-info/Chainsaw_Man'
      });
    }

    // Build the URL
    const url = `https://ww2.mangafreak.me/Manga/${seriesName}`;

    // Fetch the series page
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
    
    // Extract series information
    const seriesTitle = $('.manga_series_data h1').text().trim() || 
                       $('h1').first().text().trim() || 
                       'Unknown Series';
    
    const seriesDescription = $('.manga_series_data .manga_series_description').text().trim() ||
                             $('.description').text().trim() || '';
    
    const seriesCover = $('.manga_series_image img').attr('src') || '';
    
    // Extract all chapters from the table
    const chapters = [];
    $('table tbody tr').each((i, elem) => {
      const $row = $(elem);
      const $link = $row.find('td:first-child a');
      
      if ($link.length > 0) {
        const chapterUrl = $link.attr('href');
        const chapterText = $link.text().trim();
        const dateText = $row.find('td:nth-child(2)').text().trim();
        
        const chapterMatch = chapterText.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
        const chapterNumber = chapterMatch ? chapterMatch[1] : '';
        
        const fullUrl = chapterUrl.startsWith('http') 
          ? chapterUrl 
          : `https://ww2.mangafreak.me${chapterUrl}`;
        
        // Extract series name from URL
        const seriesMatch = chapterUrl.match(/Read1_([^_]+(?:_[^_]+)*)_\d+/);
        const seriesName = seriesMatch ? seriesMatch[1] : '';
        const chapterId = seriesName && chapterNumber ? `${seriesName}/${chapterNumber}` : '';
        
        chapters.push({
          chapterId,
          chapterNumber,
          chapterText,
          url: fullUrl,
          releaseDate: dateText
        });
      }
    });

    // Extract series metadata
    const metadata = {};
    const infoText = $('.manga_series_data').text();
    
    const authorMatch = infoText.match(/Author[:\s]+([^\n]+)/i);
    if (authorMatch) metadata.author = authorMatch[1].trim();
    
    const genreMatch = infoText.match(/Genre[:\s]+([^\n]+)/i);
    if (genreMatch) {
      metadata.genres = genreMatch[1].split(',').map(g => g.trim());
    }
    
    const statusMatch = infoText.match(/Status[:\s]+([^\n]+)/i);
    if (statusMatch) metadata.status = statusMatch[1].trim();

    res.json({
      success: true,
      seriesName,
      series: {
        title: seriesTitle,
        description: seriesDescription,
        coverImage: seriesCover,
        metadata
      },
      totalChapters: chapters.length,
      chapters: chapters.reverse() // Reverse to show newest first
    });

  } catch (error) {
    console.error('MangaFreak manga-info error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch manga info',
      details: error.message
    });
  }
});

// Download multiple chapters as ZIP
router.get('/download-multiple-chapters', async (req, res) => {
  try {
    const { chapterIds, folderName } = req.query;
    
    if (!chapterIds) {
      return res.status(400).json({ 
        success: false,
        error: 'chapterIds parameter is required',
        example: '/manga/mangafreak/download-multiple-chapters?chapterIds=Chainsaw_Man/212,Chainsaw_Man/213&folderName=Chainsaw_Man'
      });
    }

    // Parse chapter IDs (format: "Series_Name/Chapter,Series_Name/Chapter")
    const chapters = chapterIds.split(',').map(id => {
      const [series, chapter] = id.trim().split('/');
      return { series, chapter };
    });

    if (chapters.length === 0 || chapters.some(c => !c.series || !c.chapter)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid chapterIds format. Use: Series_Name/Chapter,Series_Name/Chapter',
        example: 'Chainsaw_Man/212,Chainsaw_Man/213'
      });
    }

    const zipName = folderName || chapters[0].series || 'manga_chapters';
    
    // Set response headers for ZIP download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName.replace(/[<>:"/\\|?*]/g, '_')}.zip"`);

    // Create archive
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    // Pipe archive to response
    archive.pipe(res);

    // Download each chapter
    for (const { series, chapter } of chapters) {
      try {
        const url = `https://ww2.mangafreak.me/Read1_${series}_${chapter}`;
        
        // Fetch the chapter page
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
        
        // Extract all image URLs
        const imageUrls = [];
        $('img[id="gohere"]').each((i, elem) => {
          const src = $(elem).attr('src');
          if (src) {
            imageUrls.push({
              url: src,
              pageNumber: i + 1
            });
          }
        });

        if (imageUrls.length === 0) {
          console.warn(`No images found for ${series} Chapter ${chapter}`);
          continue;
        }

        // Create folder name for this chapter
        const chapterFolderName = `Chapter_${chapter}`;

        // Download and add each image to the archive
        for (const img of imageUrls) {
          try {
            const imageResponse = await axios.get(img.url, {
              responseType: 'arraybuffer',
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Referer': 'https://ww2.mangafreak.me/',
                'Origin': 'https://ww2.mangafreak.me'
              },
              timeout: 30000
            });

            // Get file extension from URL
            const extension = img.url.split('.').pop().split('?')[0] || 'jpg';
            const fileName = `${chapterFolderName}/${String(img.pageNumber).padStart(3, '0')}.${extension}`;
            
            // Add image to archive
            archive.append(Buffer.from(imageResponse.data), { name: fileName });
            
          } catch (imgError) {
            console.error(`Failed to download image ${img.pageNumber} from ${series} Chapter ${chapter}:`, imgError.message);
          }
        }

        console.log(`Successfully processed ${series} Chapter ${chapter} (${imageUrls.length} images)`);

      } catch (chapterError) {
        console.error(`Failed to process ${series} Chapter ${chapter}:`, chapterError.message);
      }
    }

    // Finalize the archive
    await archive.finalize();

  } catch (error) {
    console.error('MangaFreak multiple download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to download chapters',
        details: error.message
      });
    }
  }
});

// Download chapter as ZIP
router.get('/download-chapter/:series/:chapter', async (req, res) => {
  try {
    const { series, chapter } = req.params;
    const url = `https://ww2.mangafreak.me/Read1_${series}_${chapter}`;
    
    // Fetch the chapter page
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
    const title = $('title').text().replace(/[<>:"/\\|?*]/g, '_');
    
    // Extract all image URLs
    const imageUrls = [];
    $('img[id="gohere"]').each((i, elem) => {
      const src = $(elem).attr('src');
      if (src) {
        imageUrls.push({
          url: src,
          pageNumber: i + 1
        });
      }
    });

    if (imageUrls.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No images found in chapter'
      });
    }

    // Set response headers for ZIP download
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${series}_Chapter_${chapter}.zip"`);

    // Create archive
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    // Pipe archive to response
    archive.pipe(res);

    // Download and add each image to the archive
    for (const img of imageUrls) {
      try {
        const imageResponse = await axios.get(img.url, {
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Referer': 'https://ww2.mangafreak.me/',
            'Origin': 'https://ww2.mangafreak.me'
          },
          timeout: 30000
        });

        // Get file extension from URL
        const extension = img.url.split('.').pop().split('?')[0] || 'jpg';
        const fileName = `${String(img.pageNumber).padStart(3, '0')}.${extension}`;
        
        // Add image to archive
        archive.append(Buffer.from(imageResponse.data), { name: fileName });
        
      } catch (imgError) {
        console.error(`Failed to download image ${img.pageNumber}:`, imgError.message);
      }
    }

    // Finalize the archive
    await archive.finalize();

  } catch (error) {
    console.error('MangaFreak download error:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'Failed to download chapter',
        details: error.message
      });
    }
  }
});


router.get('/', (req, res) => {
  res.json({
    provider: 'MangaFreak',
    version: '1.0.0',
    baseUrl: 'https://ww2.mangafreak.me',
    endpoints: [
      {
        path: '/anilist/:id',
        method: 'GET',
        description: 'Get manga information from AniList by manga ID with MangaFreak chapters',
        parameters: {
          id: 'AniList manga ID (required)',
          seriesName: 'MangaFreak series name to fetch chapters (optional)'
        },
        example: '/manga/mangafreak/anilist/105778'
      },
      {
        path: '/anilist-search/:title',
        method: 'GET',
        description: 'Search for manga on AniList by title',
        parameters: {
          title: 'Manga title to search (required)'
        },
        example: '/manga/mangafreak/anilist-search/Chainsaw Man'
      },
      {
        path: '/proxy',
        method: 'GET',
        description: 'Proxy any URL to bypass CORS restrictions',
        parameters: {
          url: 'URL to proxy (required)'
        },
        example: '/manga/mangafreak/proxy?url=https://images.mangafreak.me/mangas/chainsaw_man/chainsaw_man_218/chainsaw_man_218_3.jpg'
      },
      {
        path: '/read/:series/:chapter',
        method: 'GET',
        description: 'Read a specific manga chapter by series name and chapter number',
        parameters: {
          series: 'Series name with underscores (e.g., Chainsaw_Man)',
          chapter: 'Chapter number'
        },
        example: '/manga/mangafreak/read/Chainsaw_Man/218'
      },
      {
        path: '/manga-info/:seriesName',
        method: 'GET',
        description: 'Get manga series information and all chapters by series name',
        parameters: {
          seriesName: 'Series name with underscores (e.g., Chainsaw_Man)'
        },
        example: '/manga/mangafreak/manga-info/Chainsaw_Man'
      },
      {
        path: '/download-multiple-chapters',
        method: 'GET',
        description: 'Download multiple manga chapters as a single ZIP file with organized folders',
        parameters: {
          chapterIds: 'Comma-separated list of chapter IDs in format Series_Name/Chapter (required)',
          folderName: 'Name for the ZIP file (optional, defaults to first series name)'
        },
        example: '/manga/mangafreak/download-multiple-chapters?chapterIds=Chainsaw_Man/212,Chainsaw_Man/213&folderName=Chainsaw_Man'
      },
      {
        path: '/download-chapter/:series/:chapter',
        method: 'GET',
        description: 'Download manga chapter as ZIP file with all images',
        parameters: {
          series: 'Series name with underscores (e.g., Chainsaw_Man)',
          chapter: 'Chapter number'
        },
        example: '/manga/mangafreak/download-chapter/Chainsaw_Man/218'
      }
    ]
  });
});

module.exports = router;