const express = require('express');
const axios = require('axios');
const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Base URL for MangaDX API
const MANGADX_BASE_URL = 'https://api.mangadex.org';

// Helper function to make API requests with error handling
async function makeApiRequest(endpoint, params = {}) {
    try {
        const response = await axios.get(`${MANGADX_BASE_URL}${endpoint}`, {
            params,
            headers: {
                'User-Agent': 'MangaDX-Scraper/1.0'
            },
            timeout: 10000
        });
        return response.data;
    } catch (error) {
        console.error(`API Request failed for ${endpoint}:`, error.message);
        throw new Error(`Failed to fetch data: ${error.message}`);
    }
}

// Route to get all manga with pagination
app.get('/api/manga', async (req, res) => {
    try {
        const {
            limit = 10,
            offset = 0,
            title,
            status,
            publicationDemographic,
            contentRating,
            tags,
            order = JSON.stringify({ updatedAt: 'desc' })
        } = req.query;

        const params = {
            limit: Math.min(parseInt(limit), 100), // MangaDX limits to 100
            offset: parseInt(offset),
            order: typeof order === 'string' ? JSON.parse(order) : order,
            includes: ['cover_art', 'author', 'artist']
        };

        // Add optional filters
        if (title) params.title = title;
        if (status) params.status = status;
        if (publicationDemographic) params.publicationDemographic = publicationDemographic;
        if (contentRating) params.contentRating = contentRating;
        if (tags) params.includedTags = Array.isArray(tags) ? tags : [tags];

        const data = await makeApiRequest('/manga', params);
        
        // Process and clean the data
        const processedData = {
            result: data.result,
            response: data.response,
            total: data.total,
            limit: data.limit,
            offset: data.offset,
            manga: data.data.map(manga => processMangaData(manga))
        };

        res.json(processedData);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch manga data',
            message: error.message
        });
    }
});

// Route to get specific manga by ID
app.get('/api/manga/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const params = {
            includes: ['cover_art', 'author', 'artist']
        };

        const data = await makeApiRequest(`/manga/${id}`, params);
        
        const processedManga = processMangaData(data.data);
        
        res.json({
            result: data.result,
            manga: processedManga
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch manga',
            message: error.message
        });
    }
});

// Route to search manga
app.get('/api/search', async (req, res) => {
    try {
        const { q, limit = 20 } = req.query;
        
        if (!q) {
            return res.status(400).json({
                error: 'Search query is required',
                message: 'Please provide a search query using the "q" parameter'
            });
        }

        const params = {
            title: q,
            limit: Math.min(parseInt(limit), 100),
            includes: ['cover_art', 'author', 'artist'],
            order: { relevance: 'desc' }
        };

        const data = await makeApiRequest('/manga', params);
        
        const searchResults = {
            query: q,
            total: data.total,
            results: data.data.map(manga => processMangaData(manga))
        };

        res.json(searchResults);
    } catch (error) {
        res.status(500).json({
            error: 'Search failed',
            message: error.message
        });
    }
});

// Route to get manga chapters
app.get('/api/manga/:id/chapters', async (req, res) => {
    try {
        const { id } = req.params;
        const { limit = 20, offset = 0, translatedLanguage = 'en' } = req.query;

        const params = {
            manga: id,
            limit: Math.min(parseInt(limit), 100),
            offset: parseInt(offset),
            translatedLanguage: Array.isArray(translatedLanguage) ? translatedLanguage : [translatedLanguage],
            order: { chapter: 'asc' },
            includes: ['scanlation_group', 'user']
        };

        const data = await makeApiRequest('/chapter', params);
        
        const chapters = {
            mangaId: id,
            total: data.total,
            chapters: data.data.map(chapter => ({
                id: chapter.id,
                title: chapter.attributes.title,
                chapter: chapter.attributes.chapter,
                volume: chapter.attributes.volume,
                pages: chapter.attributes.pages,
                translatedLanguage: chapter.attributes.translatedLanguage,
                publishAt: chapter.attributes.publishAt,
                readableAt: chapter.attributes.readableAt,
                createdAt: chapter.attributes.createdAt,
                updatedAt: chapter.attributes.updatedAt
            }))
        };

        res.json(chapters);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch chapters',
            message: error.message
        });
    }
});

// Route to get popular manga
app.get('/api/popular', async (req, res) => {
    try {
        const { limit = 20 } = req.query;

        const params = {
            limit: Math.min(parseInt(limit), 100),
            order: { followedCount: 'desc' },
            includes: ['cover_art', 'author', 'artist'],
            hasAvailableChapters: true
        };

        const data = await makeApiRequest('/manga', params);
        
        const popularManga = {
            popular: data.data.map(manga => processMangaData(manga))
        };

        res.json(popularManga);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch popular manga',
            message: error.message
        });
    }
});

// Route to get recently updated manga
app.get('/api/recent', async (req, res) => {
    try {
        const { limit = 20 } = req.query;

        const params = {
            limit: Math.min(parseInt(limit), 100),
            order: { updatedAt: 'desc' },
            includes: ['cover_art', 'author', 'artist'],
            hasAvailableChapters: true
        };

        const data = await makeApiRequest('/manga', params);
        
        const recentManga = {
            recent: data.data.map(manga => processMangaData(manga))
        };

        res.json(recentManga);
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch recent manga',
            message: error.message
        });
    }
});

// Helper function to process manga data
function processMangaData(manga) {
    const attributes = manga.attributes;
    const relationships = manga.relationships || [];
    
    // Extract cover art
    const coverArt = relationships.find(rel => rel.type === 'cover_art');
    const coverUrl = coverArt ? 
        `https://uploads.mangadx.org/covers/${manga.id}/${coverArt.attributes?.fileName}` : null;
    
    // Extract author and artist
    const author = relationships.find(rel => rel.type === 'author');
    const artist = relationships.find(rel => rel.type === 'artist');
    
    return {
        id: manga.id,
        title: attributes.title,
        altTitles: attributes.altTitles || [],
        description: attributes.description || {},
        status: attributes.status,
        publicationDemographic: attributes.publicationDemographic,
        contentRating: attributes.contentRating,
        year: attributes.year,
        tags: (attributes.tags || []).map(tag => ({
            id: tag.id,
            name: tag.attributes?.name || {},
            group: tag.attributes?.group
        })),
        coverUrl,
        author: author?.attributes?.name || 'Unknown',
        artist: artist?.attributes?.name || 'Unknown',
        originalLanguage: attributes.originalLanguage,
        availableTranslatedLanguages: attributes.availableTranslatedLanguages || [],
        lastVolume: attributes.lastVolume,
        lastChapter: attributes.lastChapter,
        links: attributes.links || {},
        createdAt: attributes.createdAt,
        updatedAt: attributes.updatedAt
    };
}

// Home route with API documentation
app.get('/', (req, res) => {
    res.json({
        message: 'MangaDX API Scraper',
        endpoints: {
            '/api/manga': 'Get all manga with optional filters',
            '/api/manga/:id': 'Get specific manga by ID',
            '/api/search?q=query': 'Search manga by title',
            '/api/manga/:id/chapters': 'Get chapters for specific manga',
            '/api/popular': 'Get popular manga',
            '/api/recent': 'Get recently updated manga'
        },
        parameters: {
            limit: 'Number of results (max 100)',
            offset: 'Pagination offset',
            status: 'ongoing, completed, hiatus, cancelled',
            contentRating: 'safe, suggestive, erotica, pornographic',
            publicationDemographic: 'shounen, shoujo, josei, seinen'
        }
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`MangaDX API Scraper running on http://localhost:${PORT}`);
    console.log('Available endpoints:');
    console.log(`- GET /api/manga - Get all manga`);
    console.log(`- GET /api/manga/:id - Get specific manga`);
    console.log(`- GET /api/search?q=query - Search manga`);
    console.log(`- GET /api/manga/:id/chapters - Get manga chapters`);
    console.log(`- GET /api/popular - Get popular manga`);
    console.log(`- GET /api/recent - Get recent manga`);
});

module.exports = app;