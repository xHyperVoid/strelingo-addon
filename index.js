#!/usr/bin/env node

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');

// OpenSubtitles API base URL
const OPENSUBS_API_URL = 'https://rest.opensubtitles.org';

// Configuration
const ADDON_PORT = process.env.PORT || 7000;
const ADDON_URL = process.env.ADDON_URL || `http://localhost:${ADDON_PORT}`;

console.log(`Addon configured for ${process.env.WEB_VERSION === 'true' ? 'WEB' : 'DESKTOP'} version of Stremio`);

// Rate limiting
const requestQueue = [];
const MAX_REQUESTS_PER_MINUTE = 40; // OpenSubtitles limit
let requestsThisMinute = 0;
let requestTimer = null;

// Create a new addon builder
const builder = new addonBuilder({
    id: 'org.stremio.turkishsubtitles',
    version: '0.0.12',
    name: 'Turkish Subtitles',
    description: 'Turkish subtitles from OpenSubtitles for movies and TV shows. Configurable for desktop or web version of Stremio.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],  // IMDB IDs
    logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b4/Flag_of_Turkey.svg/1200px-Flag_of_Turkey.svg.png',
    background: 'https://images.unsplash.com/photo-1524231757912-21f4fe3a7200',
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: false  // Set to false so the addon can be installed without configuration
    },
    config: [
        {
            key: 'version',
            type: 'select',
            title: 'Stremio Version',
            options: ['desktop', 'web'],
            default: 'desktop'
        }
    ]
});

// Reset the rate limit counter every minute
function setupRateLimitReset() {
    requestTimer = setInterval(() => {
        requestsThisMinute = 0;
        
        // Process any queued requests
        while (requestsThisMinute < MAX_REQUESTS_PER_MINUTE && requestQueue.length > 0) {
            const { resolve, reject, fn } = requestQueue.shift();
            executeWithRateLimit(fn, resolve, reject);
        }
    }, 60 * 1000);
    
    // Prevent the timer from keeping the process alive
    requestTimer.unref();
}

// Execute a function with rate limiting
function executeWithRateLimit(fn, resolve, reject) {
    if (requestsThisMinute < MAX_REQUESTS_PER_MINUTE) {
        requestsThisMinute++;
        
        Promise.resolve()
            .then(fn)
            .then(resolve)
            .catch(reject);
    } else {
        // Queue the request for the next minute
        requestQueue.push({ resolve, reject, fn });
        console.log(`Rate limit reached. Queued request. Queue size: ${requestQueue.length}`);
    }
}

// Wrap a function with rate limiting
function withRateLimit(fn) {
    // Initialize the rate limit timer if not already done
    if (!requestTimer) {
        setupRateLimitReset();
    }
    
    return new Promise((resolve, reject) => {
        executeWithRateLimit(fn, resolve, reject);
    });
}

// Define the subtitles handler
builder.defineSubtitlesHandler(async ({ type, id, extra, config }) => {
    console.log('Subtitle request:', { type, id, extra });
    
    // Log all available request information to see if we can find clues about the client
    console.log('Request extra data:', JSON.stringify(extra, null, 2));
    console.log('Config:', config);
    
    // Check if this is web version based on config
    const isWebVersion = config && config.version === 'web';
    console.log(`Using ${isWebVersion ? 'WEB' : 'DESKTOP'} version based on config`);
    
    // Parse the IMDB ID and handle series format
    let imdbId = extra && extra.imdbId ? extra.imdbId : id;
    let season = null;
    let episode = null;
    
    // Check if this is a series ID with season and episode
    if (imdbId.includes(':')) {
        const parts = imdbId.split(':');
        imdbId = parts[0];
        if (parts.length >= 3) {
            season = parts[1];
            episode = parts[2];
        }
    }
    
    if (!imdbId || !imdbId.startsWith('tt')) {
        console.log('No valid IMDB ID provided');
        return { subtitles: [] };
    }
    
    try {
        // Prepare search parameters
        const searchParams = {
            imdbid: imdbId.replace('tt', '')
        };
        
        // Add season and episode for series
        if (type === 'series') {
            if (season) searchParams.season = season;
            if (episode) searchParams.episode = episode;
            // Also check extra parameters as fallback
            if (extra && extra.season) searchParams.season = extra.season;
            if (extra && extra.episode) searchParams.episode = extra.episode;
        }
        
        // Set language to Turkish
        searchParams.sublanguageid = 'tur';
        
        // Build the search URL
        const searchUrl = buildSearchUrl(searchParams);
        console.log('Searching subtitles at:', searchUrl);
        
        // Make the request to OpenSubtitles API with rate limiting
        const response = await withRateLimit(() => 
            axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'TemporaryUserAgent'
                },
                timeout: 10000 // 10 seconds timeout
            })
        );
        
        // Process the response
        if (!response.data || !Array.isArray(response.data)) {
            console.log('Invalid response from OpenSubtitles API');
            return { subtitles: [] };
        }
        
        // Map the subtitles to Stremio format
        const subtitles = response.data
            .filter(subtitle => 
                subtitle.SubDownloadLink && 
                subtitle.SubFormat && 
                ['srt', 'vtt', 'sub', 'ass'].includes(subtitle.SubFormat.toLowerCase())
            )
            .map(subtitle => {
                // Direct URL to the subtitle file
                const directUrl = subtitle.SubDownloadLink;
                let subtitleUrl = directUrl;
                
                // For compressed files, handle differently based on Stremio version
                if (directUrl.endsWith('.gz')) {
                    if (!isWebVersion) {
                        // For desktop version, use the streaming server
                        subtitleUrl = `http://127.0.0.1:11470/subtitles.vtt?from=${encodeURIComponent(directUrl)}`;
                    } 
                }
                
                return {
                    id: subtitle.IDSubtitleFile,
                    url: subtitleUrl,
                    lang: 'tr',
                    name: `${subtitle.MovieReleaseName || subtitle.MovieName || 'Unknown'} ${
                        subtitle.SubAuthorComment ? `(${subtitle.SubAuthorComment})` : ''
                    }`,
                    rating: parseFloat(subtitle.SubRating) || 0
                };
            });
        
        // Log the first subtitle URL if available
        if (subtitles.length > 0) {
            console.log(`First subtitle URL: ${subtitles[0].url}`);
        }
        
        console.log(`Found ${subtitles.length} Turkish subtitles for ${imdbId}`);
        
        return { 
            subtitles,
            // Cache for 24 hours
            cacheMaxAge: 24 * 60 * 60,
            staleRevalidate: 24 * 60 * 60
        };
    } catch (error) {
        console.error('Error fetching subtitles:', error.message);
        
        // If the error is due to rate limiting, return a specific message
        if (error.response && error.response.status === 429) {
            console.log('Rate limit exceeded from OpenSubtitles API');
        }
        
        return { subtitles: [] };
    }
});

// Helper function to build the OpenSubtitles search URL
function buildSearchUrl(params) {
    // For series, we need a specific order: episode/imdbid/season/sublanguageid
    if (params.episode) {
        const parts = [];
        if (params.episode) parts.push(`episode-${params.episode}`);
        if (params.imdbid) parts.push(`imdbid-${params.imdbid}`);
        if (params.season) parts.push(`season-${params.season}`);
        if (params.sublanguageid) parts.push(`sublanguageid-${params.sublanguageid}`);
        return `${OPENSUBS_API_URL}/search/${parts.join('/')}`;
    }
    
    // For movies, we can use the original order
    const searchPath = Object.entries(params)
        .map(([key, value]) => `${key}-${value}`)
        .join('/');
    
    return `${OPENSUBS_API_URL}/search/${searchPath}`;
}

// Handle process termination
process.on('SIGINT', () => {
    console.log('Shutting down...');
    if (requestTimer) {
        clearInterval(requestTimer);
    }
    process.exit(0);
});

// Serve the addon
serveHTTP(builder.getInterface(), { port: ADDON_PORT });

console.log(`Turkish Subtitles Addon running at ${ADDON_URL}/manifest.json`);
console.log(`To install in Stremio, open: stremio://addon/${encodeURIComponent(ADDON_URL)}/manifest.json`);
console.log(`After installation, click the "Configure" button in the addon details to select desktop or web version`); 