const express = require('express');
const axios = require('axios');
const app = express();
const PORT = 3001;

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Proxy endpoint to fetch images from MangaPill
app.get('/proxy', async (req, res) => {
  try {
    const imageUrl = req.query.url;
    
    if (!imageUrl) {
      return res.status(400).json({ error: 'URL parameter is required' });
    }

    // Validate it's from the expected CDN
    if (!imageUrl.includes('readdetectiveconan.com') && !imageUrl.includes('mangapill.com')) {
      return res.status(403).json({ error: 'Invalid image source' });
    }

    // Fetch the image with MangaPill-specific headers
    const response = await axios({
      method: 'GET',
      url: imageUrl,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://mangapill.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site'
      },
      timeout: 15000,
      maxRedirects: 5
    });

    // Set appropriate content type and caching
    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Access-Control-Allow-Origin', '*');
    
    // Send the image
    res.send(response.data);
  } catch (error) {
    console.error('Error fetching image:', error.message);
    
    if (error.response) {
      res.status(error.response.status).json({ 
        error: 'Failed to fetch image',
        status: error.response.status,
        details: error.message 
      });
    } else {
      res.status(500).json({ 
        error: 'Failed to fetch image',
        details: error.message 
      });
    }
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'MangaPill Image Proxy' });
});

// Test endpoint with example
app.get('/', (req, res) => {
  const exampleUrl = 'https://cdn.readdetectiveconan.com/file/mangap/2/11162000/0199de68-c504-70c1-ac57-b73475f76a78/1.jpeg';
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>MangaPill Image Proxy</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
        code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
        img { max-width: 100%; height: auto; border: 1px solid #ddd; margin-top: 20px; }
        .endpoint { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0; }
      </style>
    </head>
    <body>
      <h1>🖼️ MangaPill Image Proxy Server</h1>
      <p>Proxy server for accessing MangaPill manga images</p>
      
      <div class="endpoint">
        <h3>Usage:</h3>
        <code>GET /proxy?url=YOUR_IMAGE_URL</code>
      </div>
      
      <h3>Example:</h3>
      <code>http://localhost:${PORT}/proxy?url=${encodeURIComponent(exampleUrl)}</code>
      
      <h3>Test Image:</h3>
      <img src="/proxy?url=${encodeURIComponent(exampleUrl)}" 
           alt="Proxied Manga Image" 
           onerror="this.alt='Failed to load image'">
      
      <h3>Endpoints:</h3>
      <ul>
        <li><code>/proxy?url=IMAGE_URL</code> - Fetch and proxy an image</li>
        <li><code>/health</code> - Health check</li>
      </ul>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`\n🚀 MangaPill Image Proxy Server running!`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/health`);
  console.log(`\n📖 Example usage:`);
  console.log(`   http://localhost:${PORT}/proxy?url=YOUR_IMAGE_URL\n`);
});