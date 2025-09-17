const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const qs = require('qs');

const app = express();
const port = process.env.PORT || 3000;

app.get('/get-player', async (req, res) => {
  const apiUrl = 'https://masteranime.tv/ajax/anime/load_episodes_v2?s=hserver';

  // Adjust these parameters as needed.
  const payload = qs.stringify({
    // For example, if an episode parameter is needed:
    // episode: '195673'
  });

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36',
    // Include any required cookies, e.g.,
    // 'Cookie': 'PHPSESSID=amrpg2kf527ob15eukoosucfr1'
    // Also, set Referer if required:
    // 'Referer': 'https://masteranime.tv/anime/watch/the-100-girlfriends-who-really-really-really-really-really-love-you-season-2/195673?s=hserver'
  };

  try {
    const response = await axios.post(apiUrl, payload, { headers });
    const data = response.data;

    // Check if the response indicates a valid player embed
    if (data.status && data.embed) {
      // The "value" contains the embed HTML code (an iframe)
      const iframeHtml = data.value.trim();

      // Optionally, use Cheerio if you need to manipulate or extract attributes.
      // For example, you can extract the iframe src attribute:
      const $ = cheerio.load(iframeHtml);
      const playerUrl = $('iframe').attr('src');

      // Serve an HTML page that embeds the player iframe.
      res.send(`
        <html>
          <head>
            <title>Embedded Player</title>
            <style>
              html, body { margin: 0; height: 100%; }
              iframe { width: 100%; height: 100%; border: none; }
            </style>
          </head>
          <body>
            ${iframeHtml}
            <!-- Alternatively, if you want to use just the URL:
            <iframe src="${playerUrl}" allowfullscreen
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture">
            </iframe>
            -->
          </body>
        </html>
      `);
    } else {
      console.error('Response does not include a valid player embed:', data);
      res.status(404).send('Player not found in the response (status false).');
    }
  } catch (error) {
    console.error('Error fetching player:', error);
    res.status(500).send('Error fetching player');
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
