const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const crypto = require('crypto');
const fs = require('fs');

// Create cookie jar without custom agents
const jar = new CookieJar();
const client = wrapper(axios.create({
  jar,
  withCredentials: true,
  validateStatus: status => true, // Accept all status codes to analyze response
  timeout: 30000
}));

// Generate more realistic browser fingerprints
function generateFingerprint() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  ];
  
  return {
    userAgent: userAgents[Math.floor(Math.random() * userAgents.length)],
    clientId: crypto.randomBytes(16).toString('hex'),
    timestamp: Date.now(),
    screenWidth: [1366, 1440, 1536, 1920, 2560][Math.floor(Math.random() * 5)],
    screenHeight: [768, 900, 864, 1080, 1440][Math.floor(Math.random() * 5)],
    platform: ['Win32', 'MacIntel', 'Linux x86_64'][Math.floor(Math.random() * 3)],
    doNotTrack: Math.random() > 0.5 ? '1' : null
  };
}

// Function to extract challenge solving parameters
async function extractChallengeData(html) {
  let challengeData = { params: {} };
  
  try {
    // Extract script src
    const scriptMatch = html.match(/src="(\/\.well-known\/ddos-guard\/[^"]*?)"/);
    if (scriptMatch) {
      challengeData.scriptSrc = scriptMatch[1];
    }
    
    // Extract all data attributes for the challenge
    const dataAttrs = html.match(/data-[a-z0-9_-]+="[^"]*?"/g) || [];
    dataAttrs.forEach(attr => {
      const [key, value] = attr.replace(/"/g, '').split('=');
      challengeData.params[key] = value;
    });
    
    // Extract any form inputs
    const formInputs = html.match(/<input[^>]*name="([^"]*)"[^>]*value="([^"]*)"[^>]*>/g) || [];
    formInputs.forEach(input => {
      const nameMatch = input.match(/name="([^"]*)"/);
      const valueMatch = input.match(/value="([^"]*)"/);
      if (nameMatch && valueMatch) {
        challengeData.params[nameMatch[1]] = valueMatch[1];
      }
    });
    
    // Extract form action URL
    const formMatch = html.match(/<form[^>]*action="([^"]*)"[^>]*>/);
    if (formMatch) {
      challengeData.formAction = formMatch[1];
    }
    
  } catch (e) {
    console.log('Failed to extract challenge data:', e.message);
  }
  
  return challengeData;
}

// Generate essential challenge parameters
function generateChallengeResponse(challengeData) {
  return {
    // Common challenge parameters
    'd-guard': challengeData.params['data-ddg-origin'] || '',
    'token': challengeData.token || '',
    '_': Math.floor(Date.now() / 1000) - 5
  };
}

async function bypassDdosGuard() {
  // Create a more realistic fingerprint
  const fingerprint = generateFingerprint();
  
  // Enhanced browser-like headers
  const headers = {
    'User-Agent': fingerprint.userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'max-age=0',
    'Sec-Ch-Ua': '"Chromium";v="125", "Google Chrome";v="125"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': `"${fingerprint.platform ? fingerprint.platform.split(' ')[0] : 'Windows'}"`,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'DNT': fingerprint.doNotTrack
  };

  const targetUrl = 'https://animepahe.ru/';
  
  try {
    // Try to load cookies from file if they exist
    try {
      if (fs.existsSync('./ddos_cookies.json')) {
        const savedCookies = JSON.parse(fs.readFileSync('./ddos_cookies.json'));
        for (const cookie of savedCookies) {
          await jar.setCookie(`${cookie.key}=${cookie.value}`, targetUrl);
        }
        console.log('Loaded saved cookies');
      }
    } catch (e) {
      console.log('No saved cookies or error loading them');
    }
    
    // Step 1: Initial request with delay-retry mechanism
    console.log('Step 1: Initial request to the site...');
    let maxRetries = 3;
    let challengeHtml = '';
    let firstResponse;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        firstResponse = await client.get(targetUrl, { 
          headers,
          maxRedirects: 5,
          timeout: 30000,
          responseType: 'text'
        });
        
        console.log(`Got status: ${firstResponse.status}`);
        challengeHtml = firstResponse.data;
        
        // If we got a 200, we might already be past the protection
        if (firstResponse.status === 200 && 
            typeof challengeHtml === 'string' && 
            !challengeHtml.includes('DDoS-Guard')) {
          console.log('Already bypassed protection or no protection!');
          return true;
        }
        
        // Exit retry loop if we got a challenge page
        if (typeof challengeHtml === 'string' && challengeHtml.includes('DDoS-Guard')) {
          break;
        }
        
        // Wait between retries with varying times
        const waitTime = 3000 + Math.floor(Math.random() * 2000);
        console.log(`Retrying in ${waitTime}ms... (attempt ${i+1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } catch (e) {
        console.log(`Request error on attempt ${i+1}: ${e.message}`);
        // Continue to next retry
      }
    }
    
    // Check if we got the DDoS challenge page
    if (typeof challengeHtml === 'string' && challengeHtml.includes('DDoS-Guard')) {
      console.log('Received DDoS-Guard challenge page, extracting parameters...');
      
      // Extract challenge data with enhanced extraction
      const challengeData = await extractChallengeData(challengeHtml);
      console.log('Challenge data:', challengeData);
      
      // Get cookies from jar
      const cookies = await jar.getCookies(targetUrl);
      console.log('Cookies received:', cookies.map(c => `${c.key}=${c.value}`).join('; '));
      
      // Step 2: Fetch all challenge resources to appear legitimate
      if (challengeData && challengeData.scriptSrc) {
        console.log(`Fetching challenge script: ${challengeData.scriptSrc}`);
        try {
          await client.get(`${targetUrl.replace(/\/$/, '')}${challengeData.scriptSrc}`, {
            headers: {
              ...headers,
              'Referer': targetUrl
            }
          });
          console.log('Successfully retrieved challenge script');
        } catch (e) {
          console.log('Failed to fetch challenge script:', e.message);
        }
      }
      
      // Step 3: Send "heartbeat" request to check.ddos-guard.net
      try {
        console.log('Sending heartbeat to check.ddos-guard.net...');
        await client.get('https://check.ddos-guard.net/check.js', {
          headers: {
            ...headers,
            'Referer': targetUrl
          }
        });
      } catch (e) {
        console.log('Heartbeat request failed:', e.message);
      }
      
      // Add some delays to simulate human timing
      const delayTime = 3000 + Math.floor(Math.random() * 4000);
      console.log(`Waiting for ${delayTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayTime));
      
      // Step 4: Submit challenge response if form action is available
      if (challengeData.formAction) {
        const challengeResponse = generateChallengeResponse(challengeData);
        console.log('Submitting challenge response:', challengeResponse);
        
        try {
          await client.post(
            challengeData.formAction.startsWith('http') 
              ? challengeData.formAction 
              : `${targetUrl.replace(/\/$/, '')}${challengeData.formAction}`, 
            challengeResponse, 
            {
              headers: {
                ...headers,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': targetUrl
              }
            }
          );
        } catch (e) {
          console.log('Challenge submission error:', e.message);
        }
      }
      
      // Wait to simulate human behavior
      const waitTime = 5000 + Math.floor(Math.random() * 3000);
      console.log(`Waiting for ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    // Step 5: Try again with the cookies we've acquired
    console.log('Step 5: Following up with acquired cookies...');
    const cookies = await jar.getCookies(targetUrl);
    
    // If we got cookies, save them for future use
    if (cookies.length > 0) {
      fs.writeFileSync('./ddos_cookies.json', JSON.stringify(cookies));
      console.log('Saved cookies for future sessions');
    }
    
    // Try 3 times with short delays between attempts
    for (let attempt = 0; attempt < 3; attempt++) {
      headers['Referer'] = targetUrl;
      
      const secondResponse = await client.get(targetUrl, {
        headers
      });
      
      // Check if we've successfully bypassed
      if (secondResponse.status === 200 && 
          typeof secondResponse.data === 'string' && 
          !secondResponse.data.includes('DDoS-Guard')) {
        console.log('Successfully bypassed DDoS-Guard!');
        return true;
      } else {
        console.log(`Still hitting protection. Status: ${secondResponse.status}, Attempt: ${attempt+1}/3`);
        
        // Wait between attempts with varying delay
        const delay = 3000 + Math.floor(Math.random() * 2000);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    
    console.log('Failed to bypass DDoS protection after multiple attempts');
    return false;
    
  } catch (error) {
    console.error('Error during bypass attempt:', error.message);
    if (error.response) {
      console.log('Error details:', {
        status: error.response.status,
        headers: error.response.headers
      });
    }
    return false;
  }
}

async function fetchAnimePahe() {
  try {
    const bypassed = await bypassDdosGuard();
    
    if (!bypassed) {
      console.error('Could not bypass protection, aborting');
      return;
    }
    
    // Now make the actual API request
    console.log('Fetching API...');
    const response = await client.get('https://animepahe.ru/api', {
      params: {
        m: 'links',
        id: '67ce9d96765835e4657093df2d7b75f58aa9a41b76226d987173a1b261a4c4c4',
        p: 'kwik'
      },
      headers: {
        'User-Agent': generateFingerprint().userAgent,
        'Referer': 'https://animepahe.ru/',
        'Accept': 'application/json, text/plain, */*',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    
    console.log('Success:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    return null;
  }
}

// Run the script
fetchAnimePahe();