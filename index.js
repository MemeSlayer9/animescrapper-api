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
app.use((err, req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  console.error("[UNHANDLED]", err.message);
  res.status(500).json({ success: false, error: err.message });
});
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

// ── Crunchyroll dub detection ─────────────────────────────────────────────────
async function fetchCrunchyrollDubInfo(crSeriesId) {
  const result = { hasDub: false, dubbedEpisodes: new Set() };
  if (!crSeriesId) return result;

  try {
    const tokenRes = await axios.post(
      "https://www.crunchyroll.com/auth/v1/token",
      "grant_type=client_id",
      {
        headers: {
          "Content-Type":  "application/x-www-form-urlencoded",
          "Authorization": "Basic Y3Jfd2ViOg==",
        },
        timeout: 8000,
      }
    );
    const token = tokenRes.data?.access_token;
    if (!token) return result;

    const cms = tokenRes.data?.cms || {};
    const policy    = cms.policy    || "";
    const signature = cms.signature || "";
    const keyPairId = cms.key_pair_id || "";
    const bucket    = cms.bucket    || "";

    const authHeader = { Authorization: `Bearer ${token}` };

    const seasonsRes = await axios.get(
      `https://www.crunchyroll.com/cms/v2${bucket}/seasons`,
      {
        params: { series_id: crSeriesId, Policy: policy, Signature: signature, "Key-Pair-Id": keyPairId, locale: "en-US" },
        headers: authHeader,
        timeout: 10000,
      }
    );

    const seasons = seasonsRes.data?.items || [];
    if (seasons.length === 0) return result;

    const dubbedSeasons = seasons.filter(s => s.is_dubbed === true);
    if (dubbedSeasons.length === 0) return result;

    result.hasDub = true;

    await Promise.all(dubbedSeasons.map(async season => {
      try {
        const epsRes = await axios.get(
          `https://www.crunchyroll.com/cms/v2${bucket}/episodes`,
          {
            params: { season_id: season.id, Policy: policy, Signature: signature, "Key-Pair-Id": keyPairId, locale: "en-US" },
            headers: authHeader,
            timeout: 10000,
          }
        );
        const eps = epsRes.data?.items || [];
        for (const ep of eps) {
          if (ep.episode_number != null && ep.is_dubbed) {
            result.dubbedEpisodes.add(ep.episode_number);
          }
        }
      } catch (e) {
        console.warn(`[CR] Episodes fetch for season ${season.id}:`, e.message);
      }
    }));

    console.log(`[CR] hasDub=${result.hasDub}, dubbedEps=[${[...result.dubbedEpisodes].join(",")}]`);
  } catch (e) {
    console.warn("[CR] fetchCrunchyrollDubInfo:", e.message);
  }

  return result;
}

// ── Detect season number — only count TV anime prequels ───────────────────────
function detectSeasonNumber(relations = []) {
  const prequels = (relations.edges || []).filter(e =>
    e.relationType === "PREQUEL" &&
    e.node.type === "ANIME" &&
    e.node.format === "TV"
  );
  return prequels.length + 1;
}

// ── TMDB: search anime specifically (with Animation genre filter) ─────────────
async function searchTMDBAnime(title, year) {
  try {
    const res = await axios.get(`${TMDB_API}/search/tv`, {
      params: {
        api_key: TMDB_KEY,
        query:   title,
        first_air_date_year: year || undefined,
        with_genres: "16",
      },
      timeout: 10000,
    });
    const results = res.data?.results || [];
    if (results.length > 0) {
      const titleLower = title.toLowerCase();
      const exact = results.find(r =>
        (r.name || "").toLowerCase() === titleLower ||
        (r.original_name || "").toLowerCase() === titleLower
      );
      const picked = exact ? exact.id : results[0].id;
      console.log(`[TMDB] searchTMDBAnime found ID ${picked} for "${title}" (animation filter)`);
      return picked;
    }

    const res2 = await axios.get(`${TMDB_API}/search/tv`, {
      params: {
        api_key: TMDB_KEY,
        query:   title,
        first_air_date_year: year || undefined,
      },
      timeout: 10000,
    });
    const results2 = res2.data?.results || [];
    if (results2.length === 0) return null;
    const titleLower = title.toLowerCase();
    const exact2 = results2.find(r =>
      (r.name || "").toLowerCase() === titleLower ||
      (r.original_name || "").toLowerCase() === titleLower
    );
    const picked2 = exact2 ? exact2.id : results2[0].id;
    console.log(`[TMDB] searchTMDBAnime found ID ${picked2} for "${title}" (no genre filter)`);
    return picked2;
  } catch (e) {
    console.warn("[TMDB] searchTMDBAnime:", e.message);
    return null;
  }
}

// ── TMDB: validate that a resolved ID is actually an animation show ───────────
async function validateTMDBIsAnimation(tmdbId) {
  try {
    const res = await axios.get(`${TMDB_API}/tv/${tmdbId}`, {
      params: { api_key: TMDB_KEY },
      timeout: 8000,
    });
    const genres = (res.data.genres || []).map(g => g.name.toLowerCase());
    return genres.includes("animation") || genres.includes("anime");
  } catch (e) {
    console.warn(`[TMDB] validateTMDBIsAnimation(${tmdbId}):`, e.message);
    return true;
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

// ── buildTMDBLookup ───────────────────────────────────────────────────────────
async function buildTMDBLookup(tmdbId, targetYear, seasonNumber = null, episodeCount = null) {
  const lookup = new Map();
  try {
    const seriesRes = await axios.get(`${TMDB_API}/tv/${tmdbId}`, {
      params: { api_key: TMDB_KEY }, timeout: 10000,
    });

    const seasons = (seriesRes.data?.seasons || []).filter(
      s => s.season_number > 0 && s.episode_count > 0
    );
    if (seasons.length === 0) return lookup;

    let seasonsToFetch;
    let filterByYear = null;

    if (seasonNumber !== null && seasonNumber >= 2) {
      const matched = seasons.find(s => s.season_number === seasonNumber);
      if (matched) {
        seasonsToFetch = [matched];
        console.log(`[TMDB] Sequel: fetching only Season ${seasonNumber} for TMDB ID ${tmdbId}`);
      } else {
        console.warn(`[TMDB] Season ${seasonNumber} not found on TMDB. Will filter episodes by year ${targetYear}.`);
        seasonsToFetch = seasons;
        filterByYear = targetYear || null;
      }
    } else {
      console.log(`[TMDB] Season 1 / long-running: fetching all ${seasons.length} season(s) for TMDB ID ${tmdbId}`);
      seasonsToFetch = seasons;
    }

    console.log(`[TMDB] Will fetch ${seasonsToFetch.length} season(s) for TMDB ID ${tmdbId}`);

    const BATCH = 5;
    const seasonResults = [];
    for (let i = 0; i < seasonsToFetch.length; i += BATCH) {
      const batch = seasonsToFetch.slice(i, i + BATCH);
      const fetched = await Promise.all(
        batch.map(async season => {
          try {
            const sRes = await axios.get(
              `${TMDB_API}/tv/${tmdbId}/season/${season.season_number}`,
              { params: { api_key: TMDB_KEY }, timeout: 15000 }
            );
            return { episodes: sRes.data?.episodes || [], seasonNum: season.season_number };
          } catch (e) {
            console.warn(`[TMDB] Season ${season.season_number}:`, e.message);
            return { episodes: [], seasonNum: season.season_number };
          }
        })
      );
      seasonResults.push(...fetched);
    }

    seasonResults.sort((a, b) => a.seasonNum - b.seasonNum);

    let allEpisodes = [];
    for (const result of seasonResults) {
      if (!result?.episodes) continue;
      for (const ep of result.episodes) {
        allEpisodes.push(ep);
      }
    }

    if ((seasonNumber === null || seasonNumber === 1) && episodeCount && allEpisodes.length > episodeCount) {
      allEpisodes = allEpisodes.slice(0, episodeCount);
      console.log(`[TMDB] Capped to ${episodeCount} episodes (AniList episode count) for TMDB ID ${tmdbId}`);
    }

    if (filterByYear) {
      allEpisodes = allEpisodes.filter(ep =>
        ep.air_date && parseInt(ep.air_date.substring(0, 4)) === filterByYear
      );
      console.log(`[TMDB] After year-filter (${filterByYear}): ${allEpisodes.length} episodes`);
    }

    let absNum = 1;
    for (const ep of allEpisodes) {
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

    console.log(`[TMDB] Built lookup with ${lookup.size} total episodes for TMDB ID ${tmdbId}`);
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

// ── Shared media fields fragment (used in trending + popular) ─────────────────
const MEDIA_LIST_FIELDS = `
  id
  title { romaji english native }
  description(asHtml: false)
  coverImage { extraLarge large color }
  bannerImage
  episodes
  duration
  status
  season
  seasonYear
  averageScore
  meanScore
  popularity
  favourites
  genres
  format
  source
  isAdult
  studios(isMain: true) { nodes { name } }
  nextAiringEpisode { episode airingAt timeUntilAiring }
  streamingEpisodes { title thumbnail url site }
  trailer { id site }
  externalLinks { url site color }
  tags { name rank isMediaSpoiler }
  startDate { year month day }
  endDate   { year month day }
  countryOfOrigin
  siteUrl
`;

// ── Trending query ────────────────────────────────────────────────────────────
const TRENDING_QUERY = `
  query ($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage }
      media(sort: TRENDING_DESC, type: ANIME, isAdult: false) {
        ${MEDIA_LIST_FIELDS}
      }
    }
  }`;

// ── Popular query ─────────────────────────────────────────────────────────────
const POPULAR_QUERY = `
  query ($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage }
      media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) {
        ${MEDIA_LIST_FIELDS}
      }
    }
  }`;

// ── Search query ──────────────────────────────────────────────────────────────
const SEARCH_QUERY = `
  query ($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total currentPage lastPage hasNextPage }
      media(search: $search, type: ANIME) {
        ${MEDIA_LIST_FIELDS}
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
      characters(perPage: 12, sort: ROLE) {
        edges {
          role
          node { id name { full } image { large } siteUrl }
          voiceActors(language: JAPANESE, sort: RELEVANCE) {
            id name { full } image { large } languageV2
          }
        }
      }
      nextAiringEpisode { episode airingAt timeUntilAiring }
      airingSchedule(perPage: 50) { nodes { episode airingAt } }
      streamingEpisodes { title thumbnail url site }
      relations {
        edges {
          relationType(version: 2)
          node { id title { romaji } coverImage { medium } type format status }
        }
      }
      recommendations(perPage: 10, sort: RATING_DESC) {
        nodes {
          mediaRecommendation {
            id
            title { romaji english }
            coverImage { medium }
            averageScore
            format
            episodes
          }
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

// ── Helper: normalize a media list item for trending/popular responses ─────────
function normalizeMediaItem(m) {
  return {
    id:          m.id,
    title:       m.title,
    description: m.description || null,
    coverImage:  m.coverImage,
    bannerImage: m.bannerImage || null,
    episodes:    m.episodes    || null,
    duration:    m.duration    || null,
    status:      m.status      || null,
    season:      m.season      || null,
    seasonYear:  m.seasonYear  || null,
    averageScore: m.averageScore || null,
    meanScore:   m.meanScore   || null,
    popularity:  m.popularity  || null,
    favourites:  m.favourites  || null,
    genres:      m.genres      || [],
    format:      m.format      || null,
    source:      m.source      || null,
    isAdult:     m.isAdult     || false,
    studios:     (m.studios?.nodes || []).map(n => n.name),
    nextAiringEpisode: m.nextAiringEpisode || null,
    streamingEpisodes: (m.streamingEpisodes || []).slice(0, 5), // cap to 5 for list views
    trailer:     m.trailer     || null,
    externalLinks: m.externalLinks || [],
    tags:        (m.tags || []).filter(t => !t.isMediaSpoiler).slice(0, 8),
    startDate:   m.startDate   || null,
    endDate:     m.endDate     || null,
    countryOfOrigin: m.countryOfOrigin || null,
    siteUrl:     m.siteUrl     || null,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * GET /api/trending
 * Returns anime sorted by AniList's TRENDING_DESC score.
 * Query params: page (default 1), perPage (default 20, max 50)
 */
app.get("/api/trending", async (req, res) => {
  try {
    const page    = parseInt(req.query.page)    || 1;
    const perPage = Math.min(parseInt(req.query.perPage) || 20, 50);
    const data    = await anilistQuery(TRENDING_QUERY, { page, perPage });
    res.json({
      success: true,
      source:  "anilist",
      sort:    "TRENDING_DESC",
      pageInfo: data.Page.pageInfo,
      media:   (data.Page.media || []).map(normalizeMediaItem),
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

/**
 * GET /api/popular
 * Returns anime sorted by AniList's POPULARITY_DESC score.
 * Same response shape as /api/trending.
 * Query params: page (default 1), perPage (default 20, max 50)
 */
app.get("/api/popular", async (req, res) => {
  try {
    const page    = parseInt(req.query.page)    || 1;
    const perPage = Math.min(parseInt(req.query.perPage) || 20, 50);
    const data    = await anilistQuery(POPULAR_QUERY, { page, perPage });
    res.json({
      success: true,
      source:  "anilist",
      sort:    "POPULARITY_DESC",
      pageInfo: data.Page.pageInfo,
      media:   (data.Page.media || []).map(normalizeMediaItem),
    });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/api/search", async (req, res) => {
  try {
    const search = req.query.q;
    if (!search) return res.status(400).json({ success: false, error: "'q' required" });
    const page    = parseInt(req.query.page)    || 1;
    const perPage = Math.min(parseInt(req.query.perPage) || 20, 50);
    const data    = await anilistQuery(SEARCH_QUERY, { search, page, perPage });
    res.json({
      success: true,
      source:  "anilist",
      pageInfo: data.Page.pageInfo,
      media:   (data.Page.media || []).map(normalizeMediaItem),
    });
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

    const seasonNumber = detectSeasonNumber(media.relations || {});
    console.log(`[Info] Anime ID ${id} ("${media.title?.romaji}") detected as Season ${seasonNumber}`);

    const externalIds = extractExternalIds(media.externalLinks || []);

    let tmdbId = externalIds.tmdb ? parseInt(externalIds.tmdb) : null;

    if (tmdbId) {
      const isAnimation = await validateTMDBIsAnimation(tmdbId);
      if (!isAnimation) {
        console.warn(`[TMDB] ID ${tmdbId} is live-action. Re-searching for anime version...`);
        const searchTitle = media.title?.english || media.title?.romaji;
        const searchYear  = seasonNumber === 1 ? (media.seasonYear || null) : null;
        const animeTmdbId = await searchTMDBAnime(searchTitle, searchYear);
        if (animeTmdbId) {
          console.log(`[TMDB] Found anime TMDB ID ${animeTmdbId} (was ${tmdbId})`);
          tmdbId = animeTmdbId;
          externalIds.tmdb = String(tmdbId);
        } else {
          console.warn(`[TMDB] Could not find anime version, keeping ID ${tmdbId}`);
        }
      }
    } else {
      const searchTitle = media.title?.english || media.title?.romaji;
      const cleanTitle = searchTitle
        ? searchTitle.replace(/\s*(season\s*\d+|\d+(st|nd|rd|th)\s*season)\s*$/i, "").trim()
        : null;

      if (cleanTitle) {
        console.log(`[TMDB] No direct link found, searching anime by title: "${cleanTitle}"`);
        const searchYear = seasonNumber === 1 ? (media.seasonYear || null) : null;
        tmdbId = await searchTMDBAnime(cleanTitle, searchYear);
        if (tmdbId) {
          console.log(`[TMDB] Found TMDB ID ${tmdbId} via title search`);
          externalIds.tmdb = String(tmdbId);
        }
      }
    }

    let tmdbInfo     = null;
    let tmdbEpisodes = [];
    let dubInfo      = { hasDub: false, dubbedEpisodes: new Set() };

    const crSeriesId = externalIds.crunchyroll || null;

    if (tmdbId) {
      const [info, lookup, dub] = await Promise.all([
        fetchTMDBInfo(tmdbId),
        buildTMDBLookup(tmdbId, media.seasonYear || null, seasonNumber, media.episodes || null),
        fetchCrunchyrollDubInfo(crSeriesId),
      ]);

      tmdbInfo     = info;
      dubInfo      = dub;
      tmdbEpisodes = [...lookup.entries()]
        .sort(([a], [b]) => a - b)
        .map(([absEp, ep]) => ({ absoluteEpisode: absEp, ...ep }));
    } else {
      dubInfo = await fetchCrunchyrollDubInfo(crSeriesId);
    }

    const airedEps = (media.airingSchedule?.nodes || []).map(ep => ({
      episode:  ep.episode,
      airingAt: ep.airingAt,
      aired:    ep.airingAt * 1000 <= Date.now(),
    }));

    const airedMap = new Map(airedEps.map(e => [e.episode, e]));
    const tmdbMap  = new Map(tmdbEpisodes.map(e => [e.absoluteEpisode, e]));
    const allNums  = new Set([...airedMap.keys(), ...tmdbMap.keys()]);

    const now = Date.now();

    const mergedEps = [...allNums].sort((a, b) => a - b).map(num => {
      const tmdbEp  = tmdbMap.get(num)  || {};
      const airedEp = airedMap.get(num) || {};
      const hasDub  = dubInfo.dubbedEpisodes.size > 0
        ? dubInfo.dubbedEpisodes.has(num)
        : dubInfo.hasDub;
      return {
        episode: num,
        ...tmdbEp,
        ...airedEp,
        aired:  airedEp.aired ?? tmdbEp.aired ?? null,
        hasDub,
      };
    }).filter(ep => {
      if (ep.airingAt) return ep.airingAt * 1000 <= now;
      if (ep.airDate)  return new Date(ep.airDate).getTime() <= now;
      return ep.aired === true;
    });

    const streamingEps = (media.streamingEpisodes || []).map(ep => ({ ...ep, streaming: true }));

    const airedEpsOnly     = airedEps.filter(ep => ep.aired);
    const tmdbEpisodesOnly = tmdbEpisodes.filter(ep => {
      if (ep.airDate) return new Date(ep.airDate).getTime() <= now;
      return ep.aired === true;
    });

    const characters = (media.characters?.edges || []).map(edge => ({
      id:    edge.node.id,
      name:  edge.node.name,
      image: edge.node.image?.large || null,
      role:  edge.role,
      voiceActors: (edge.voiceActors || []).map(va => ({
        id:       va.id,
        name:     va.name,
        image:    va.image?.large || null,
        language: va.languageV2  || null,
      })),
    }));

    const recommendations = (media.recommendations?.nodes || [])
      .map(n => n.mediaRecommendation)
      .filter(Boolean)
      .map(r => ({
        id:       r.id,
        title:    r.title,
        image:    r.coverImage?.medium || null,
        rating:   r.averageScore       || null,
        type:     r.format             || null,
        episodes: r.episodes           || null,
      }));

    res.json({
      success: true,
      anime:   media,
      externalIds,
      tmdb:    tmdbInfo,
      seasonNumber,
      recommendations,
      characters,
      dub: {
        hasDub:         dubInfo.hasDub,
        dubbedUpToEp:   dubInfo.dubbedEpisodes.size > 0 ? Math.max(...dubInfo.dubbedEpisodes) : null,
        dubbedEpisodes: [...dubInfo.dubbedEpisodes].sort((a, b) => a - b),
      },
      episodes: {
        total:     tmdbEpisodesOnly.length || media.episodes || null,
        merged:    mergedEps,
        streaming: streamingEps,
        tmdb:      tmdbEpisodesOnly,
        aired:     airedEpsOnly,
      },
      meta: scrapedData,
    });
  } catch (e) {
    console.error("[/api/anime/:id]", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get("/api/tmdb/:tmdbId", async (req, res) => {
  try {
    const tmdbId = parseInt(req.params.tmdbId);
    if (isNaN(tmdbId)) return res.status(400).json({ success: false, error: "Invalid TMDB ID" });
    const year         = parseInt(req.query.year)   || null;
    const seasonNumber = parseInt(req.query.season) || null;
    const [info, lookup] = await Promise.all([
      fetchTMDBInfo(tmdbId),
      buildTMDBLookup(tmdbId, year, seasonNumber),
    ]);
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
  console.log(`   /api/trending`);
  console.log(`   /api/popular`);
  console.log(`   /api/search?q=`);
  console.log(`   /api/anime/:id`);
  console.log(`   /api/tmdb/:tmdbId`);
  console.log(`   /api/seasonal\n`);
});