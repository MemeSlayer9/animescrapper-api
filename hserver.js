const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const app = express();
const port = 3000;

// Middleware to parse JSON requests
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from 'public' directory
app.use(express.static('public'));

// Home route
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>M3U8 Scraper</title></head>
      <body>
        <h1>M3U8 Stream Scraper</h1>
        <form action="/scrape" method="POST">
          <input type="text" name="url" placeholder="Enter website URL" size="50" required>
          <button type="submit">Scrape</button>
        </form>
      </body>
    </html>
  `);
});

// Route to handle scraping
app.post('/scrape', async (req, res) => {
  try {
    const targetUrl = req.body.url;
    
    // Step 1: Fetch the webpage
    const response = await axios.get(targetUrl);
    const html = response.data;
    
    // Step 2: Use cheerio to parse the HTML and find potential video sources
    const $ = cheerio.load(html);
    const m3u8Sources = [];
    
    // Look for script tags that might contain m3u8 URLs
    $('script').each((i, script) => {
      const content = $(script).html();
      if (content) {
        // Look for m3u8 patterns in script content
        const m3u8Pattern = /(https?:\/\/[^"'\s]+\.m3u8)/g;
        const matches = content.match(m3u8Pattern);
        if (matches) {
          m3u8Sources.push(...matches);
        }
      }
    });
    
    // Also check for video source elements
    $('source').each((i, source) => {
      const src = $(source).attr('src');
      if (src && src.includes('m3u8')) {
        m3u8Sources.push(src);
      }
    });
    
    // Return the found sources
    if (m3u8Sources.length > 0) {
      res.json({ 
        success: true, 
        message: 'Found potential M3U8 sources', 
        sources: [...new Set(m3u8Sources)] // Remove duplicates
      });
    } else {
      res.json({ 
        success: false, 
        message: 'No M3U8 sources found directly. Try analyzing network requests during video playback.'
      });
    }
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'An error occurred while scraping',
      error: error.message
    });
  }
});

// Route to get M3U8 playlist details
app.get('/analyze-m3u8', async (req, res) => {
  try {
    const m3u8Url = req.query.url;
    
    if (!m3u8Url) {
      return res.status(400).json({ success: false, message: 'M3U8 URL is required' });
    }
    
    // Fetch the M3U8 playlist
    const response = await axios.get(m3u8Url);
    const playlistContent = response.data;
    
    // Basic analysis of the M3U8 content
    const isVariant = playlistContent.includes('#EXT-X-STREAM-INF');
    
    if (isVariant) {
      // Parse the variants (different quality streams)
      const variants = [];
      const lines = playlistContent.split('\n');
      
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('#EXT-X-STREAM-INF')) {
          const info = lines[i];
          const url = lines[i+1];
          
          // Extract resolution/bandwidth info
          const resolution = info.match(/RESOLUTION=(\d+x\d+)/)?.[1] || 'Unknown';
          const bandwidth = info.match(/BANDWIDTH=(\d+)/)?.[1] || 'Unknown';
          
          variants.push({
            resolution,
            bandwidth,
            url: url.startsWith('http') ? url : new URL(url, m3u8Url).href
          });
        }
      }
      
      res.json({
        success: true,
        type: 'Master Playlist',
        variantCount: variants.length,
        variants
      });
    } else {
      // Count segments
      const segmentCount = (playlistContent.match(/#EXTINF/g) || []).length;
      
      res.json({
        success: true,
        type: 'Media Playlist',
        segmentCount,
        duration: playlistContent.match(/#EXT-X-TARGETDURATION:(\d+)/)?.[1] || 'Unknown'
      });
    }
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to analyze M3U8 playlist',
      error: error.message
    });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`M3U8 scraper server running at http://localhost:${port}`);
});