const express = require('express');
const axios = require('axios');
const cors = require('cors');
const cheerio = require('cheerio');

const app = express();
app.use(cors());

const DECODE_MAP = {
  "01":"9","08":"0","05":"=","0a":"2","0b":"3","0c":"4","07":"?","00":"8",
  "5c":"d","0f":"7","5e":"f","17":"/","54":"l","09":"1","48":"p","4f":"w",
  "0e":"6","5b":"c","5d":"e","0d":"5","53":"k","1e":"&","5a":"b","59":"a",
  "4a":"r","4c":"t","4e":"v","57":"o","51":"i"
};

function decodeSourceUrl(encoded) {
  let result = "";
  encoded.replace("--", "").match(/.{1,2}/g)?.forEach(s => {
    if (s in DECODE_MAP) result += DECODE_MAP[s];
  });
  return result;
}

const ALLANIME_BASE = "https://allanime.day";
const ALLANIME_API  = "https://api.allanime.day/allanimeapi";
const SKIP_SOURCES  = ["Ak", "Yt-mp4", "Vid-mp4", "Sl-mp4"];

// GET / - API docs
app.get('/', (req, res) => {
  res.json({
    name: "🎌 Anime Scraper API",
    version: "1.0.0",
    endpoints: [
      {
        method: "GET",
        path: "/details/:animeId",
        description: "Get anime info and full episode list",
        example: "http://localhost:3000/details/ReooPAxPMsHM4KPMY",
        returns: "{ animeId, name, thumbnail, total, episodes[] }"
      },
      {
        method: "GET",
        path: "/sources/:episodeId",
        description: "Get all video sources for an episode",
        example: "http://localhost:3000/sources/ReooPAxPMsHM4KPMY&episode=1&type=sub",
        returns: "{ animeId, episode, type, videos[] }"
      },
      {
  method: "GET",
  path: "/recent",
  description: "Browse anime list from AllanimeAPI",
  example: "/recent?page=1&type=dub",
  returns: "{ page, type, total, animes[] }"
},
    ],
    usage: {
      step1: "GET /details/:animeId    → get episode list",
      step2: "GET /sources/:episodeId  → get video sources"
    },
    
    examples: {
      details: "http://localhost:3000/details/ReooPAxPMsHM4KPMY",
      sources: "http://localhost:3000/sources/ReooPAxPMsHM4KPMY&episode=1&type=sub"
    }
  });
});

// GET /details/:animeId
app.get('/details/:animeId', async (req, res) => {
  const { animeId } = req.params;

  try {
    const { data } = await axios.get(ALLANIME_API, {
      params: {
        variables: JSON.stringify({ _id: animeId }),
        extensions: JSON.stringify({
          persistedQuery: {
            sha256Hash: "043448386c7a686bc2aabfbb6b80f6074e795d350df48015023b079527b0848a",
            version: 1
          }
        })
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
        'Origin': 'https://allanime.to',
        'Referer': 'https://allanime.to/',
      }
    });

    const show = data?.data?.show;
    if (!show) return res.status(404).json({ error: 'Anime not found', raw: data });

    const { availableEpisodesDetail, name, thumbnail, _id } = show;
    const episodes = [];

    ['sub', 'dub', 'raw'].forEach(type => {
      (availableEpisodesDetail?.[type] || []).forEach(ep => {
        const episodeId = `${_id}&episode=${ep}&type=${type}`;
        episodes.push({
          episodeId,
          episode: ep,
          type,
          label: `${type} Episode ${ep}`,
          videoUrl: `http://localhost:3000/sources/${episodeId}`
        });
      });
    });

    episodes.sort((a, b) => parseFloat(a.episode) - parseFloat(b.episode));

    res.json({ animeId: _id, name, thumbnail, total: episodes.length, episodes });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /browse?page=1&type=sub
app.get('/recent', async (req, res) => {
  const { page = 1, type = 'sub' } = req.query;

  try {
    const { data } = await axios.get(ALLANIME_API, {
      params: {
        variables: JSON.stringify({
          translationType: type,
          countryOrigin: 'ALL',
          search: {},
          limit: 26,
          page: parseInt(page)
        }),
        extensions: JSON.stringify({
          persistedQuery: {
            sha256Hash: "a24c500a1b765c68ae1d8dd85174931f661c71369c89b92b88b75a725afc471c",
            version: 1
          }
        })
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
        'Origin': 'https://allanime.to',
        'Referer': 'https://allanime.to/',
      }
    });

    const shows = data?.data?.shows?.edges || [];

    const animes = shows.map(show => ({
      animeId: show._id,
      title: show.name,
      image: show.thumbnail?.startsWith('http')
        ? show.thumbnail
        : `https://wp.youtube-anime.com/aln.youtube-anime.com/${show.thumbnail}`,
      genres: show.genres || [],
      score: show.score || null,
      availableEpisodes: show.availableEpisodes || {},
      detailsUrl: `http://localhost:3000/details/${show._id}`
    }));

    res.json({
      page: parseInt(page),
      type,
      total: animes.length,
      animes
    });

  } catch (err) {
    res.status(500).json({ error: err.message, raw: err.response?.data });
  }
});
// GET /sources/:episodeId  (e.g. ReooPAxPMsHM4KPMY&episode=1&type=sub)
app.get('/sources/:episodeId', async (req, res) => {
  const raw = req.params.episodeId;
  const match = raw.match(/^(.+?)&episode=(.+?)&type=(.+)$/);
  if (!match) return res.status(400).json({
    error: 'Invalid episodeId format',
    expected: 'animeId&episode=1&type=sub',
    example: '/sources/ReooPAxPMsHM4KPMY&episode=1&type=sub'
  });

  const [, animeId, episode, type] = match;

  try {
    const { data } = await axios.get(ALLANIME_API, {
      params: {
        variables: JSON.stringify({ showId: animeId, episodeString: episode, translationType: type }),
        extensions: JSON.stringify({
          persistedQuery: {
            sha256Hash: "d405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec",
            version: 1
          }
        })
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
        'Origin': 'https://allanime.to',
        'Referer': 'https://allanime.to/',
      }
    });

    const episodeData = data?.data?.episode;
    if (!episodeData) return res.status(404).json({ error: 'Episode not found' });

    const clockUrls = [];
    const videos = [];

    episodeData.sourceUrls?.forEach(p => {
      if (SKIP_SOURCES.includes(p.sourceName)) return;
      if (p.sourceUrl.startsWith("--")) {
        let decoded = decodeSourceUrl(p.sourceUrl).replace("clock", "clock.json");
        if (decoded.startsWith("/")) decoded = `${ALLANIME_BASE}${decoded}`;
        clockUrls.push({ name: p.sourceName, url: decoded });
      } else if (!p.sourceUrl.startsWith("#")) {
        videos.push({ name: p.sourceName, source: p.sourceUrl, videoType: p.type !== "player" ? "iframe" : "mp4" });
      }
    });

    const clockResults = await Promise.all(
      clockUrls.map(async ({ name, url }) => {
        try {
          const r = await axios.get(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
              'Referer': 'https://allanime.to/',
              'Origin': 'https://allanime.to',
            }
          });
          return { name, data: r.data };
        } catch (e) {
          return { name, error: e.message };
        }
      })
    );

    clockResults.forEach(({ name, data: clockData }) => {
      if (!clockData?.links) return;
      clockData.links.forEach(v => {
        const src = v?.src ?? v?.link;
        if (!src) return;
        videos.push({
          name: `${name} - ${new URL(src).hostname}`,
          source: src,
          videoType: v.hls ? "m3u8" : "mp4",
          headers: v.headers || {}
        });
      });
    });

    res.json({ animeId, episode, type, videos });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('🎌 Anime Scraper API running on http://localhost:3000');
  console.log('📖 Docs: http://localhost:3000/');
});