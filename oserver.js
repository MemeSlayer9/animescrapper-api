const express = require("express");
const cors    = require("cors");
const axios   = require("axios");
const cheerio = require("cheerio");
const path    = require("path");

const app  = express();
const PORT = process.env.PORT || 3000;

const ANILIST_API = "https://graphql.anilist.co";
const TMDB_API    = "https://api.themoviedb.org/3";
const TMDB_KEY    = process.env.TMDB_API_KEY || "699be86b7a4ca2c8bc77525cb4938dc0";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── External-link → ID rules ─────────────────────────────────────────────────
const EXTERNAL_ID_RULES = [
  { key: "tmdb",        sites: ["themoviedb","tmdb"],    pattern: /themoviedb\.org\/tv\/(\d+)/ },
  { key: "tmdbMovie",   sites: ["themoviedb","tmdb"],    pattern: /themoviedb\.org\/movie\/(\d+)/ },
  { key: "tvdb",        sites: ["thetvdb","tvdb"],       pattern: /thetvdb\.com\/(?:series|derbyid)\/([^\/?#]+)/ },
  { key: "mal",         sites: ["myanimelist","mal"],    pattern: /myanimelist\.net\/anime\/(\d+)/ },
  { key: "anidb",       sites: ["anidb"],                pattern: /anidb\.net\/(?:anime|a)[\/?]?(\d+)/ },
  { key: "kitsu",       sites: ["kitsu"],                pattern: /kitsu\.(?:io|app)\/anime\/([^\/?#]+)/ },
  { key: "crunchyroll", sites: ["crunchyroll"],          pattern: /crunchyroll\.com\/series\/([^\/?#]+)/ },
  { key: "netflix",     sites: ["netflix"],              pattern: /netflix\.com\/title\/(\d+)/ },
  { key: "livechart",   sites: ["livechart"],            pattern: /livechart\.me\/anime\/(\d+)/ },
  { key: "anisearch",   sites: ["anisearch"],            pattern: /anisearch\.(?:com|de)\/anime\/(\d+)/ },
  { key: "notify",      sites: ["notify.moe","notify"],  pattern: /notify\.moe\/anime\/([^\/?#]+)/ },
  { key: "hidive",      sites: ["hidive"],               pattern: /hidive\.com\/tv\/([^\/?#]+)/ },
  { key: "amazon",      sites: ["amazon"],               pattern: /amazon\.(?:com|co\.jp)\/.*?(?:dp|gp\/product)\/([A-Z0-9]{10})/ },
];

function extractExternalIds(links = []) {
  const ids = {};
  for (const link of links) {
    const url = link.url || "";
    for (const rule of EXTERNAL_ID_RULES) {
      if (ids[rule.key]) continue;
      if (!rule.sites.some(s => url.toLowerCase().includes(s))) continue;
      const m = url.match(rule.pattern);
      if (m) ids[rule.key] = m[1];
    }
  }
  return ids;
}

// ── TMDB: search by title fallback ───────────────────────────────────────────
async function searchTMDBByTitle(title, year) {
  try {
    const res = await axios.get(`${TMDB_API}/search/tv`, {
      params: {
        api_key:             TMDB_KEY,
        query:               title,
        first_air_date_year: year || undefined,
      },
      timeout: 10000,
    });
    const results = res.data?.results || [];
    if (results.length === 0) return null;

    // Try to find a strong name match first
    const titleLower = title.toLowerCase();
    const exact = results.find(r =>
      (r.name || "").toLowerCase() === titleLower ||
      (r.original_name || "").toLowerCase() === titleLower
    );
    return exact ? exact.id : results[0].id;
  } catch (e) {
    console.warn("[TMDB] searchTMDBByTitle:", e.message);
    return null;
  }
}

// ── TMDB helpers ──────────────────────────────────────────────────────────────
async function fetchTMDBInfo(tmdbId) {
  try {
    const r = await axios.get(`${TMDB_API}/tv/${tmdbId}`, {
      params: { api_key: TMDB_KEY }, timeout: 10000,
    });
    return {
      tmdbId,
      name:          r.data.name,
      overview:      r.data.overview,
      firstAirDate:  r.data.first_air_date,
      totalSeasons:  r.data.number_of_seasons,
      totalEpisodes: r.data.number_of_episodes,
      posterPath:    r.data.poster_path   ? `https://image.tmdb.org/t/p/w500${r.data.poster_path}`        : null,
      backdropPath:  r.data.backdrop_path ? `https://image.tmdb.org/t/p/original${r.data.backdrop_path}` : null,
      genres:        r.data.genres?.map(g => g.name) || [],
      rating:        r.data.vote_average,
      seasons: (r.data.seasons || []).filter(s => s.season_number > 0).map(s => ({
        seasonNumber: s.season_number, episodeCount: s.episode_count,
        airDate: s.air_date, name: s.name,
        poster: s.poster_path ? `https://image.tmdb.org/t/p/w500${s.poster_path}` : null,
      })),
    };
  } catch (e) { console.warn("[TMDB] fetchTMDBInfo:", e.message); return null; }
}

async function buildTMDBLookup(tmdbId, targetYear) {
  const lookup = new Map();
  try {
    const seriesRes = await axios.get(`${TMDB_API}/tv/${tmdbId}`, {
      params: { api_key: TMDB_KEY }, timeout: 10000,
    });

    // Filter out specials (season 0) and seasons with no episodes
    const seasons = (seriesRes.data?.seasons || []).filter(
      s => s.season_number > 0 && s.episode_count > 0
    );

    // ── Season selection strategy ────────────────────────────────────────────
    // For short series (≤3 seasons) and a targetYear hint, try to match by year
    // so we don't over-fetch.  For long-running shows (4+ seasons) like One Piece,
    // always fetch every season so we get the full episode list.
    let seasonsToFetch;
    if (targetYear && seasons.length <= 3) {
      const byYear =
        seasons.find(s => s.air_date && parseInt(s.air_date.substring(0, 4)) === targetYear) ||
        seasons.find(s => s.air_date && Math.abs(parseInt(s.air_date.substring(0, 4)) - targetYear) === 1);
      seasonsToFetch = byYear ? [byYear] : seasons;
    } else {
      // Always fetch all seasons for long-running / multi-season series
      seasonsToFetch = seasons;
    }

    console.log(`[TMDB] Fetching ${seasonsToFetch.length} season(s) for TMDB ID ${tmdbId}`);

    // Fetch all seasons concurrently in batches of 5 to avoid rate limiting
    const BATCH = 5;
    let absNum = 1;

    // We need results in order, so collect then sort
    const seasonResults = new Array(seasonsToFetch.length);

    for (let i = 0; i < seasonsToFetch.length; i += BATCH) {
      const batch = seasonsToFetch.slice(i, i + BATCH);
      const fetched = await Promise.all(
        batch.map(async (season, bIdx) => {
          try {
            const sRes = await axios.get(
              `${TMDB_API}/tv/${tmdbId}/season/${season.season_number}`,
              { params: { api_key: TMDB_KEY }, timeout: 15000 }
            );
            return { index: i + bIdx, episodes: sRes.data?.episodes || [] };
          } catch (e) {
            console.warn(`[TMDB] Season ${season.season_number}:`, e.message);
            return { index: i + bIdx, episodes: [] };
          }
        })
      );
      for (const result of fetched) {
        seasonResults[result.index] = result.episodes;
      }
    }

    // Build the absolute-episode lookup in season order
    for (const episodes of seasonResults) {
      if (!episodes) continue;
      for (const ep of episodes) {
        lookup.set(absNum, {
          title:         ep.name        || null,
          overview:      ep.overview    || null,
          airDate:       ep.air_date    || null,
          aired:         ep.air_date ? new Date(ep.air_date) <= new Date() : null,
          rating:        ep.vote_average != null ? String(ep.vote_average) : null,
          thumbnail:     ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
          seasonNumber:  ep.season_number  ?? null,
          episodeNumber: ep.episode_number ?? null,
        });
        absNum++;
      }
    }

    console.log(`[TMDB] Built lookup with ${lookup.size} episodes for TMDB ID ${tmdbId}`);
  } catch (e) { console.warn("[TMDB] buildTMDBLookup:", e.message); }
  return lookup;
}

// ── AniList GraphQL ───────────────────────────────────────────────────────────
async function anilistQuery(query, variables = {}) {
  const { data } = await axios.post(ANILIST_API, { query, variables }, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return data.data;
}

const TRENDING_QUERY = `
  query ($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage }
      media(sort: TRENDING_DESC, type: ANIME) {
        id title { romaji english native }
        description(asHtml: false)
        coverImage { extraLarge large color }
        bannerImage episodes status season seasonYear
        averageScore popularity genres format
        studios(isMain: true) { nodes { name } }
        nextAiringEpisode { episode airingAt }
        streamingEpisodes { title thumbnail url site }
      }
    }
  }`;

const SEARCH_QUERY = `
  query ($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage }
      media(search: $search, type: ANIME) {
        id title { romaji english native }
        description(asHtml: false)
        coverImage { extraLarge large color }
        bannerImage episodes status season seasonYear
        averageScore popularity genres format
        studios(isMain: true) { nodes { name } }
        nextAiringEpisode { episode airingAt }
        streamingEpisodes { title thumbnail url site }
      }
    }
  }`;

const ANIME_DETAIL_QUERY = `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id title { romaji english native }
      description(asHtml: false)
      coverImage { extraLarge large color }
      bannerImage episodes duration status season seasonYear
      averageScore meanScore popularity favourites
      genres format source
      tags { name rank isMediaSpoiler }
      studios(isMain: true) { nodes { name siteUrl } }
      staff(perPage: 6) { edges { role node { name { full } image { medium } siteUrl } } }
      characters(perPage: 6, role: MAIN) { edges { role node { name { full } image { medium } siteUrl } } }
      nextAiringEpisode { episode airingAt timeUntilAiring }
      airingSchedule(notYetAired: false, perPage: 50) { nodes { episode airingAt } }
      streamingEpisodes { title thumbnail url site }
      relations {
        edges {
          relationType(version: 2)
          node { id title { romaji } coverImage { medium } type format status }
        }
      }
      trailer { id site }
      externalLinks { url site color }
      siteUrl
    }
  }`;

// ── Cheerio scrape ────────────────────────────────────────────────────────────
async function scrapeAnilistPage(animeId) {
  try {
    const { data: html } = await axios.get(`https://anilist.co/anime/${animeId}`, {
      headers: { "User-Agent": "Mozilla/5.0 Chrome/120" }, timeout: 8000,
    });
    const $ = cheerio.load(html);
    return {
      ogTitle:     $('meta[property="og:title"]').attr("content")       || null,
      ogDesc:      $('meta[property="og:description"]').attr("content") || null,
      ogImage:     $('meta[property="og:image"]').attr("content")       || null,
      twitterCard: $('meta[name="twitter:card"]').attr("content")       || null,
      scraped: true,
    };
  } catch { return { scraped: false }; }
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get("/api/trending", async (req, res) => {
  try {
    const page    = parseInt(req.query.page)    || 1;
    const perPage = Math.min(parseInt(req.query.perPage) || 20, 50);
    const data    = await anilistQuery(TRENDING_QUERY, { page, perPage });
    res.json({ success: true, ...data.Page });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/search", async (req, res) => {
  try {
    const search = req.query.q;
    if (!search) return res.status(400).json({ success: false, error: "'q' required" });
    const page    = parseInt(req.query.page)    || 1;
    const perPage = Math.min(parseInt(req.query.perPage) || 20, 50);
    const data    = await anilistQuery(SEARCH_QUERY, { search, page, perPage });
    res.json({ success: true, ...data.Page });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/anime/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ success: false, error: "Invalid ID" });

    const [graphqlData, scrapedData] = await Promise.all([
      anilistQuery(ANIME_DETAIL_QUERY, { id }),
      scrapeAnilistPage(id),
    ]);
    const media = graphqlData.Media;

    // ── Extract external IDs from AniList links ──
    const externalIds = extractExternalIds(media.externalLinks || []);

    // ── Resolve TMDB ID: direct link first, then title search fallback ──
    let tmdbId = externalIds.tmdb ? parseInt(externalIds.tmdb) : null;

    if (!tmdbId) {
      const searchTitle = media.title?.english || media.title?.romaji;
      if (searchTitle) {
        console.log(`[TMDB] No direct link found, searching by title: "${searchTitle}"`);
        tmdbId = await searchTMDBByTitle(searchTitle, media.seasonYear || null);
        if (tmdbId) {
          console.log(`[TMDB] Found TMDB ID ${tmdbId} via title search`);
          externalIds.tmdb = String(tmdbId); // surface it in the response
        }
      }
    }

    // ── Fetch TMDB data if we have an ID ──
    let tmdbInfo     = null;
    let tmdbEpisodes = [];

    if (tmdbId) {
      const [info, lookup] = await Promise.all([
        fetchTMDBInfo(tmdbId),
        buildTMDBLookup(tmdbId, media.seasonYear || null),
      ]);
      tmdbInfo     = info;
      tmdbEpisodes = [...lookup.entries()]
        .sort(([a], [b]) => a - b)
        .map(([absEp, ep]) => ({ absoluteEpisode: absEp, ...ep }));
    }

    // ── AniList aired schedule (recent ~50 episodes with timestamps) ──
    const airedEps = (media.airingSchedule?.nodes || []).map(ep => ({
      episode: ep.episode, airingAt: ep.airingAt, aired: true,
    }));

    // ── Merge: TMDB episode metadata + AniList airing timestamps ──
    // TMDB is the authoritative source for episode count/titles;
    // AniList airingSchedule adds timestamps where available.
    const airedMap = new Map(airedEps.map(e => [e.episode, e]));
    const tmdbMap  = new Map(tmdbEpisodes.map(e => [e.absoluteEpisode, e]));
    const allNums  = new Set([...airedMap.keys(), ...tmdbMap.keys()]);
    const mergedEps = [...allNums].sort((a, b) => a - b).map(num => ({
      episode: num,
      ...(tmdbMap.get(num)  || {}), // TMDB base (title, thumbnail, etc.)
      ...(airedMap.get(num) || {}), // AniList overlay (airingAt timestamp)
    }));

    const streamingEps = (media.streamingEpisodes || []).map(ep => ({ ...ep, streaming: true }));

    res.json({
      success: true,
      anime:   media,
      externalIds,
      tmdb:    tmdbInfo,
      episodes: {
        total:     tmdbEpisodes.length || media.episodes || null,
        merged:    mergedEps,
        streaming: streamingEps,
        tmdb:      tmdbEpisodes,
        aired:     airedEps,
      },
      meta: scrapedData,
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/tmdb/:tmdbId", async (req, res) => {
  try {
    const tmdbId = parseInt(req.params.tmdbId);
    if (isNaN(tmdbId)) return res.status(400).json({ success: false, error: "Invalid TMDB ID" });
    const year   = parseInt(req.query.year) || null;
    const [info, lookup] = await Promise.all([fetchTMDBInfo(tmdbId), buildTMDBLookup(tmdbId, year)]);
    const episodes = [...lookup.entries()].sort(([a], [b]) => a - b).map(([absEp, ep]) => ({ absoluteEpisode: absEp, ...ep }));
    res.json({ success: true, tmdb: info, episodes });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/seasonal", async (req, res) => {
  try {
    const season     = (req.query.season || "WINTER").toUpperCase();
    const seasonYear = parseInt(req.query.year) || new Date().getFullYear();
    const page       = parseInt(req.query.page) || 1;
    const query = `
      query($season: MediaSeason, $seasonYear: Int, $page: Int) {
        Page(page: $page, perPage: 30) {
          pageInfo { total currentPage lastPage }
          media(season: $season, seasonYear: $seasonYear, type: ANIME, sort: POPULARITY_DESC) {
            id title { romaji english } coverImage { extraLarge color }
            episodes status averageScore genres format
            streamingEpisodes { title thumbnail url site }
          }
        }
      }`;
    const data = await anilistQuery(query, { season, seasonYear, page });
    res.json({ success: true, season, seasonYear, ...data.Page });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`\n🎌 AniList + TMDB  →  http://localhost:${PORT}`);
  console.log(`   /api/trending  /api/search?q=  /api/anime/:id  /api/tmdb/:tmdbId  /api/seasonal\n`);
});