#!/usr/bin/env node

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const pako = require('pako');
const { Buffer } = require('buffer');
const chardet = require('chardet');
const iconv = require('iconv-lite');
const express = require('express');
const cors = require('cors');
const { URLSearchParams } = require('url'); // Added for URL param handling

// OpenSubtitles API base URL
const OPENSUBS_API_URL = 'https://rest.opensubtitles.org';

// Configuration
const ADDON_PORT = process.env.PORT || 7000;
// Base URL - Needed for constructing subtitle URLs
// For local dev, use localhost. For deployment (Vercel etc.), use env variable.
const ADDON_BASE_URL = process.env.ADDON_URL || `http://localhost:${ADDON_PORT}`;

// Rate limiting
const requestQueue = [];
const MAX_REQUESTS_PER_MINUTE = 40; // OpenSubtitles limit
let requestsThisMinute = 0;
let requestTimer = null;

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

// Create a new addon builder
const builder = new addonBuilder({
    id: 'com.serhat.strelingo',
    version: '0.1.0',
    name: 'Strelingo - Dual Language Subtitles',
    description: 'Provides dual subtitles (main + translation) from OpenSubtitles for language learning.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    logo: 'https://raw.githubusercontent.com/Serkali-sudo/strelingo-addon/refs/heads/main/assets/strelingo_icon.jpg',
    background: 'https://raw.githubusercontent.com/Serkali-sudo/strelingo-addon/refs/heads/main/assets/strelingo_back.jpg',
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    },
    config: [
        {
            key: 'mainLang',
            type: 'select',
            title: 'Main Language (Audio Language)',
            options: ['ara', 'chi', 'dut', 'eng', 'fra', 'deu', 'hin', 'ita', 'jpn', 'kor', 'nor', 'pol', 'por', 'rus', 'spa', 'swe', 'tur'],
            required: true,
            default: 'eng'
        },
        {
            key: 'transLang',
            type: 'select',
            title: 'Translation Language (Your Language)',
            options: ['ara', 'chi', 'dut', 'eng', 'fra', 'deu', 'hin', 'ita', 'jpn', 'kor', 'nor', 'pol', 'por', 'rus', 'spa', 'swe', 'tur'],
            required: true,
            default: 'tur'
        }
    ]
});

// --- Helper Function to Fetch and Select Subtitle ---
async function fetchAndSelectSubtitle(languageId, baseSearchParams) {
    const searchParams = { ...baseSearchParams, sublanguageid: languageId };
    const searchUrl = buildSearchUrl(searchParams);
    console.log(`Searching ${languageId} subtitles at: ${searchUrl}`);

    try {
        const response = await withRateLimit(() =>
            axios.get(searchUrl, {
                headers: { 'User-Agent': 'TemporaryUserAgent' },
                timeout: 10000
            })
        );

        if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
            console.log(`No ${languageId} subtitles found or invalid API response.`);
            return null;
        }

        // Find the first valid subtitle (can be improved later, e.g., by rating)
        const firstValidSubtitle = response.data.find(subtitle =>
            subtitle.SubDownloadLink &&
            subtitle.SubFormat &&
            ['srt', 'vtt', 'sub', 'ass'].includes(subtitle.SubFormat.toLowerCase())
        );

        if (!firstValidSubtitle) {
            console.log(`No suitable subtitle format found for ${languageId}.`);
            return null;
        }

        // Prepare subtitle object (similar to before, but without complex URL handling for now)
         const directUrl = firstValidSubtitle.SubDownloadLink;
         // Basic URL handling for now - merging requires fetching content later
         let subtitleUrl = directUrl;
         if (directUrl.endsWith('.gz')) {
             // Desktop can potentially handle this via streaming server, but we need the raw file for merging
             // For now, just keep the direct link - we'll need to handle decompression later
             console.log(`Found gzipped subtitle for ${languageId}. Will need decompression.`);
             // We assume desktop behavior, so no warning needed here for .gz files
         }

        return {
            id: firstValidSubtitle.IDSubtitleFile,
            url: subtitleUrl, // This URL will be used to *fetch* the content later
            lang: firstValidSubtitle.SubLanguageID, // Keep original lang ID
            format: firstValidSubtitle.SubFormat,
            langName: firstValidSubtitle.LanguageName, // Added for logging
            releaseName: firstValidSubtitle.MovieReleaseName || firstValidSubtitle.MovieName || 'Unknown',
            rating: parseFloat(firstValidSubtitle.SubRating) || 0
        };

    } catch (error) {
        console.error(`Error fetching ${languageId} subtitles:`, error.message);
        if (error.response && error.response.status === 429) {
            console.log(`Rate limit exceeded from OpenSubtitles API while fetching ${languageId}`);
        }
        return null; // Return null on error
    }
}
// --- End Helper Function ---

// --- SRT Parsing and Merging Helpers ---

// Fetches subtitle content from URL, handles potential gzip and encoding
async function fetchSubtitleContent(url) {
    console.log(`Fetching subtitle content from: ${url}`);
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer', // Important for binary data
            timeout: 15000
        });

        let contentBuffer = Buffer.from(response.data);
        let subtitleText;

        // 1. Handle Gzip decompression first
        if (url.endsWith('.gz') || (contentBuffer.length > 2 && contentBuffer[0] === 0x1f && contentBuffer[1] === 0x8b)) {
            console.log(`Decompressing gzipped subtitle: ${url}`);
            try {
                contentBuffer = Buffer.from(pako.ungzip(contentBuffer)); // Decompress into a new buffer
                console.log(`Decompressed size: ${contentBuffer.length}`);
            } catch (unzipError) {
                console.error(`Error decompressing subtitle ${url}: ${unzipError.message}`);
                return null; // Failed decompression
            }
        }

        // 2. Detect Encoding using chardet
        let detectedEncoding = 'utf8'; // Default
        let rawDetectedEncoding = null;
        let detectionConfidence = 0; // chardet doesn't provide confidence score in the same way
        try {
            // chardet.detect expects a Buffer
            rawDetectedEncoding = chardet.detect(contentBuffer);
            console.log(`chardet raw detection: encoding=${rawDetectedEncoding}`); // Log raw detection

            if (rawDetectedEncoding) {
                const normalizedEncoding = rawDetectedEncoding.toLowerCase();
                // Map common names/aliases if needed - chardet might return different names
                switch (normalizedEncoding) {
                    case 'windows-1254':
                        detectedEncoding = 'win1254';
                        break;
                    case 'iso-8859-9':
                        detectedEncoding = 'iso88599';
                        break;
                    case 'windows-1252':
                        detectedEncoding = 'win1252';
                        break;
                    case 'utf-16le':
                        detectedEncoding = 'utf16le';
                        break;
                    case 'utf-16be':
                        detectedEncoding = 'utf16be';
                        break;
                    case 'ascii':
                    case 'us-ascii':
                        detectedEncoding = 'utf8'; // Treat ASCII as UTF-8
                        break;
                    case 'utf-8':
                         detectedEncoding = 'utf8';
                         break;
                    // Add more mappings if necessary based on chardet results
                    default:
                        // Check if iconv supports the detected encoding directly
                        if (iconv.encodingExists(normalizedEncoding)) {
                            detectedEncoding = normalizedEncoding;
                        } else {
                            console.warn(`Detected encoding '${rawDetectedEncoding}' not directly supported by iconv-lite or mapped. Falling back to UTF-8.`);
                            detectedEncoding = 'utf8'; // Fallback if unknown
                        }
                }
                console.log(`Detected encoding: ${rawDetectedEncoding}, using: ${detectedEncoding}`);
            } else {
                console.log(`Encoding detection failed for ${url}. Defaulting to UTF-8.`);
                // Try to remove potential BOM manually if UTF-8 is assumed
                if(contentBuffer.length > 3 && contentBuffer[0] === 0xEF && contentBuffer[1] === 0xBB && contentBuffer[2] === 0xBF) {
                    console.log("Found UTF-8 BOM, removing it before potential decode.");
                    contentBuffer = contentBuffer.subarray(3);
                }
            }
        } catch (detectionError) {
            console.warn(`Error during encoding detection for ${url}: ${detectionError.message}. Defaulting to UTF-8.`);
        }

        // 3. Decode using detected or default encoding
        try {
            // iconv-lite handles BOMs for UTF-8, UTF-16LE, UTF-16BE automatically
            subtitleText = iconv.decode(contentBuffer, detectedEncoding);
            console.log(`Successfully decoded subtitle ${url} using ${detectedEncoding}.`);

            // Optional: If it was detected as UTF-8, double check for the FEFF char code just in case
            // iconv *should* handle this, but as a safeguard:
            if (detectedEncoding === 'utf8' && subtitleText.charCodeAt(0) === 0xFEFF) {
                 console.log("Found BOM character after UTF-8 decode, removing it.");
                 subtitleText = subtitleText.substring(1);
            }

        } catch (decodeError) {
            console.error(`Error decoding subtitle ${url} with encoding ${detectedEncoding}: ${decodeError.message}`);
            // Fallback attempt: try decoding as Latin1 (ISO-8859-1) if initial decode failed
            console.warn(`Falling back to latin1 decoding for ${url}`);
            try {
                 subtitleText = iconv.decode(contentBuffer, 'latin1');
            } catch (fallbackError) {
                console.error(`Fallback decoding as latin1 also failed for ${url}: ${fallbackError.message}`);
                return null; // Both attempts failed
            }
        }

        console.log(`Successfully fetched and processed subtitle: ${url}`);
        return subtitleText;

    } catch (error) {
        console.error(`Error fetching subtitle content from ${url}:`, error.message);
        if (error.response) {
            console.error(`Status: ${error.response.status}, Headers: ${JSON.stringify(error.response.headers)}`);
        }
        return null;
    }
}

// Helper to convert SRT time format (HH:MM:SS,ms) to milliseconds
function parseTimeToMs(timeString) {
    // Added validation for the time string format
    if (!timeString || !/\d{2}:\d{2}:\d{2},\d{3}/.test(timeString)) {
        console.error(`Invalid time format encountered: ${timeString}`);
        return 0; // Return 0 or throw error, depending on desired strictness
    }
    const parts = timeString.split(':');
    const secondsParts = parts[2].split(',');
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const seconds = parseInt(secondsParts[0], 10);
    const milliseconds = parseInt(secondsParts[1], 10);
    return (hours * 3600 + minutes * 60 + seconds) * 1000 + milliseconds;
}

// Merges two arrays of parsed subtitles based on time
function mergeSubtitles(mainSubs, transSubs, mergeThresholdMs = 500) {
    console.log(`Merging ${mainSubs.length} main subs with ${transSubs.length} translation subs.`);
    const mergedSubs = [];
    let transIndex = 0;

    for (const mainSub of mainSubs) {
        let foundMatch = false;
        let bestMatchIndex = -1;
        let smallestTimeDiff = Infinity;

        // Ensure mainSub is valid before processing
        if (!mainSub || !mainSub.startTime || !mainSub.endTime) {
            console.warn("Skipping invalid main subtitle entry:", mainSub);
            continue;
        }

        const mainStartTime = parseTimeToMs(mainSub.startTime);
        const mainEndTime = parseTimeToMs(mainSub.endTime);

        // Search for the best matching translation subtitle around the main subtitle's time
        for (let i = transIndex; i < transSubs.length; i++) {
            const transSub = transSubs[i];

            // Ensure transSub is valid
            if (!transSub || !transSub.startTime || !transSub.endTime) {
                console.warn("Skipping invalid translation subtitle entry:", transSub);
                continue;
            }

            const transStartTime = parseTimeToMs(transSub.startTime);
            const transEndTime = parseTimeToMs(transSub.endTime);

            // Check for time overlap or closeness
            const startsOverlap = (transStartTime >= mainStartTime && transStartTime < mainEndTime);
            const endsOverlap = (transEndTime > mainStartTime && transEndTime <= mainEndTime);
            const isWithin = (transStartTime >= mainStartTime && transEndTime <= mainEndTime);
            const contains = (transStartTime < mainStartTime && transEndTime > mainEndTime);
            const timeDiff = Math.abs(mainStartTime - transStartTime); // Proximity of start times

            // Prioritize overlaps, then proximity
            if (startsOverlap || endsOverlap || isWithin || contains || timeDiff < mergeThresholdMs) {
                // This sub is a potential match. Find the *closest* start time.
                if (timeDiff < smallestTimeDiff) {
                    smallestTimeDiff = timeDiff;
                    bestMatchIndex = i;
                    // Don't break yet, keep searching for potentially *better* overlaps nearby
                }
                foundMatch = true; // Mark that we found at least one potential match
            } else if (foundMatch && transStartTime > mainEndTime + mergeThresholdMs) {
                // If we already found a match, and this trans sub starts significantly
                // after the main sub ends, we can stop searching for this main sub.
                break;
            } else if (!foundMatch && transStartTime > mainEndTime + mergeThresholdMs) {
                 // If we haven't found any match yet, and this one is too far after,
                 // we can likely stop searching for this main sub.
                 break;
             }

            // Optimization: If this translation sub ends way before the main sub *starts*,
            // advance the starting point for the *next* main sub's search.
            if (transEndTime < mainStartTime - mergeThresholdMs * 2 && i === transIndex) {
                transIndex = i + 1;
            }
        }

        // Process the best match found (if any)
        if (bestMatchIndex !== -1) {
            const bestTransSub = transSubs[bestMatchIndex];
            mergedSubs.push({
                ...mainSub, // Keep main timing and ID
                // Combine text using standard newline (\n), making translation italic and yellow
                text: `${mainSub.text}\n<font color="yellow"><i>${bestTransSub.text}</i></font>`
            });
        } else {
            // If no suitable translation match found, add the main subtitle as is
            mergedSubs.push(mainSub);
        }
    }
    console.log(`Finished merging. Result has ${mergedSubs.length} entries.`);
    return mergedSubs;
}

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

// --- REUSABLE CORE LOGIC FUNCTION --- Refactored
async function generateMergedSubtitle(imdbId, season, episode, mainLang, transLang) {
    console.log(`Generating merged subtitle for: imdb=${imdbId}, s=${season}, e=${episode}, lang1=${mainLang}, lang2=${transLang}`);
    const baseSearchParams = { imdbid: imdbId.replace('tt', '') };
    if (season) baseSearchParams.season = season;
    if (episode) baseSearchParams.episode = episode;

    // 1. Fetch Sub Info
    const [mainSubInfo, transSubInfo] = await Promise.all([
        fetchAndSelectSubtitle(mainLang, baseSearchParams),
        fetchAndSelectSubtitle(transLang, baseSearchParams)
    ]);
    if (!mainSubInfo || !transSubInfo) {
        throw new Error('Could not find subtitle metadata for one or both languages.');
    }

    // 2. Fetch Content
    const [mainSubContent, transSubContent] = await Promise.all([
        fetchSubtitleContent(mainSubInfo.url),
        fetchSubtitleContent(transSubInfo.url)
    ]);
    if (!mainSubContent || !transSubContent) {
        throw new Error('Failed to fetch content for one or both subtitles.');
    }

    // Dynamically import parser within this scope if not already available globally
    // Assuming srt-parser-2 is loaded via IIFE at the bottom
    if (typeof parseSrt !== 'function' || typeof formatSrt !== 'function') {
         throw new Error('SRT parsing functions not available.');
    }

    // 3. Parse
    const mainParsed = parseSrt(mainSubContent);
    const transParsed = parseSrt(transSubContent);
    if (!mainParsed || !transParsed) {
        throw new Error('Failed to parse one or both subtitles.');
    }

    // 4. Merge
    const mergedParsed = mergeSubtitles(mainParsed, transParsed);
    if (!mergedParsed || mergedParsed.length === 0) {
        throw new Error('Merging resulted in empty subtitles.');
    }

    // 5. Format
    const mergedSrtString = formatSrt(mergedParsed);
    if (!mergedSrtString) {
        throw new Error('Failed to format merged subtitles back to SRT.');
    }

    console.log("Successfully generated merged SRT string.");
    return mergedSrtString;
}

// --- Define Addon Handler --- Modified Response
builder.defineSubtitlesHandler(async ({ type, id, config, extra }) => {
    console.log('Subtitle handler request:', { type, id, config, extra });
    const mainLang = config?.mainLang || 'eng';
    const transLang = config?.transLang || 'tur';

    let imdbId = extra?.imdbId || id;
    let season = extra?.season;
    let episode = extra?.episode;
    if (id.includes(':')) {
        const parts = id.split(':');
        imdbId = parts[0];
        season = season || parts[1];
        episode = episode || parts[2];
    }
    if (!imdbId || !imdbId.startsWith('tt')) {
        console.log('No valid IMDB ID provided');
        return { subtitles: [] };
    }

    try {
        // Check if subtitles *can* be generated (fetch info only)
        const baseSearchParams = { imdbid: imdbId.replace('tt', '') };
        if (type === 'series' && season && episode) {
            baseSearchParams.season = season;
            baseSearchParams.episode = episode;
        }
        const [mainSubInfoCheck, transSubInfoCheck] = await Promise.all([
            fetchAndSelectSubtitle(mainLang, baseSearchParams),
            fetchAndSelectSubtitle(transLang, baseSearchParams)
        ]);

        if (!mainSubInfoCheck || !transSubInfoCheck) {
            console.log('Subtitle info check failed for one or both languages.');
            return { subtitles: [], cacheMaxAge: 300 }; // Cache failure shortly
        }

        // If info exists, construct the link to our serving endpoint
        const urlParams = new URLSearchParams({
            imdb: imdbId,
            s: season || '',
            e: episode || '',
            lang1: mainLang,
            lang2: transLang
        });
        const serveUrl = `${ADDON_BASE_URL}/serve/subtitle.srt?${urlParams.toString()}`;

        console.log(`Providing subtitle URL: ${serveUrl}`);
        return {
            subtitles: [{
                id: `strelingo-${mainLang}-${transLang}`, // Simpler ID
                url: serveUrl,
                lang: `${mainLang}+${transLang}`, // Custom lang code
                name: `[${mainLang.toUpperCase()}/${transLang.toUpperCase()}] Strelingo Dual`
            }],
            cacheMaxAge: 6 * 3600,
            staleRevalidate: 24 * 3600
        };

    } catch (error) {
        console.error('Error in subtitle handler:', error.message, error.stack);
        return { subtitles: [], cacheMaxAge: 60 };
    }
});

// --- Main Async IIFE to handle ESM import and setup Server ---
// Define parseSrt and formatSrt here so they are in scope
let parseSrt, formatSrt;

(async () => {
    try {
        // Dynamically import the ESM module
        const { default: SRTParser2 } = await import('srt-parser-2');
        console.log("Successfully imported srt-parser-2.");

        // --- Parser Dependent Helpers (Define inside IIFE) ---
        parseSrt = function(srtText) {
            if (!srtText || typeof srtText !== 'string') {
                console.error("Invalid input to parseSrt: not a string or empty.");
                return null;
            }
            try {
                const parser = new SRTParser2();
                if (srtText.charCodeAt(0) === 0xFEFF) {
                    console.log("Found BOM in parseSrt, removing it.");
                    srtText = srtText.substring(1);
                }
                srtText = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                const subtitles = parser.fromSrt(srtText);
                if (!Array.isArray(subtitles)) {
                    console.error("Parsing did not return an array."); return null;
                }
                if (subtitles.length > 0 && (!subtitles[0].startTime || !subtitles[0].text)) {
                    console.warn("Parsed structure seems invalid."); return null;
                }
                console.log(`Parsed ${subtitles.length} subtitle entries.`);
                return subtitles;
            } catch (error) {
                console.error('Error parsing SRT:', error.message);
                return null;
            }
        }

        formatSrt = function(subtitleArray) {
            if (!Array.isArray(subtitleArray)) {
                console.error("Invalid input to formatSrt: not an array.");
                return null;
            }
            try {
                const parser = new SRTParser2();
                const sanitizedArray = subtitleArray.map((sub, index) => ({
                    ...sub,
                    id: (index + 1).toString()
                }));
                return parser.toSrt(sanitizedArray);
            } catch (error) {
                console.error('Error formatting SRT:', error.message);
                console.error('Problematic data for formatSrt:', JSON.stringify(subtitleArray.slice(0, 2)));
                return null;
            }
        }

        // --- Setup Express Server ---
        const app = express();
        app.use(cors()); // Enable CORS for all routes

        // --- NEW: Add route handler for serving generated subtitles ---
        app.get('/serve/subtitle.srt', async (req, res) => {
            console.log('Request received for generated subtitle:', req.query);
            try {
                const { imdb, s, e, lang1, lang2 } = req.query;
                if (!imdb || !lang1 || !lang2) {
                    return res.status(400).send('Missing required parameters');
                }
                // Use the refactored function
                const mergedSrtString = await generateMergedSubtitle(imdb, s, e, lang1, lang2);

                res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
                res.status(200).send(mergedSrtString);

            } catch (error) {
                console.error('Error generating merged subtitle:', error.message);
                res.status(500).send(`Error generating subtitle: ${error.message}`);
            }
        });

        // --- Integrate SDK Router ---
        const sdkRouter = getRouter(builder.getInterface());
        app.use(sdkRouter);

        // --- Handle process termination ---
        process.on('SIGINT', () => {
            console.log('Shutting down...');
            if (requestTimer) clearInterval(requestTimer);
            process.exit(0);
        });

        // --- Start Server ---
        app.listen(ADDON_PORT, () => {
            console.log(`Strelingo Addon server running at ${ADDON_BASE_URL}`);
            console.log(`Manifest available at ${ADDON_BASE_URL}/manifest.json`);
            console.log(`Configure and install via: ${ADDON_BASE_URL}/configure`);
        });

        console.log("Addon server setup complete.");

    } catch (err) {
        console.error("Failed to import srt-parser-2 or setup addon:", err);
        process.exit(1);
    }
})();

console.log("Addon script initialized. Waiting for ESM import and server start..."); 