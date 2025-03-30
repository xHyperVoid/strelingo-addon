#!/usr/bin/env node

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const pako = require('pako');
const { Buffer } = require('buffer');
const jschardet = require('jschardet');
const iconv = require('iconv-lite');

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
    id: 'org.stremio.dualsubtitles',
    version: '0.1.0',
    name: 'Dual Language Subtitles',
    description: 'Provides dual subtitles (main + translation) from OpenSubtitles for language learning.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    logo: 'https://img.icons8.com/ios/452/translate-app.png',
    background: 'https://images.unsplash.com/photo-1524231757912-21f4fe3a7200',
    catalogs: [],
    behaviorHints: {
        configurable: true,
        configurationRequired: true
    },
    config: [
        {
            key: 'version',
            type: 'select',
            title: 'Stremio Version (Web requires manual subtitle upload)',
            options: ['desktop', 'web'],
            default: 'desktop'
        },
        {
            key: 'mainLang',
            type: 'select',
            title: 'Main Language (Audio Language)',
            options: ['eng', 'tur', 'spa', 'fra', 'deu', 'ita', 'por'],
            required: true,
            default: 'eng'
        },
        {
            key: 'transLang',
            type: 'select',
            title: 'Translation Language (Your Language)',
            options: ['eng', 'tur', 'spa', 'fra', 'deu', 'ita', 'por'],
            required: true,
            default: 'tur'
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

// --- Helper Function to Fetch and Select Subtitle ---
async function fetchAndSelectSubtitle(languageId, baseSearchParams, isWebVersion) {
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
         if (directUrl.endsWith('.gz') && !isWebVersion) {
             // Desktop can potentially handle this via streaming server, but we need the raw file for merging
             // For now, just keep the direct link - we'll need to handle decompression later
             console.log(`Found gzipped subtitle for ${languageId}. Will need decompression.`);
             // subtitleUrl = `http://127.0.0.1:11470/subtitles.vtt?from=${encodeURIComponent(directUrl)}`;
         } else if (directUrl.endsWith('.gz') && isWebVersion) {
            console.warn(`Gzipped subtitles (${languageId}) might not work directly in the web version without server-side processing.`);
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

        // 2. Detect Encoding
        let detectedEncoding = 'utf8'; // Default
        try {
            const detected = jschardet.detect(contentBuffer);
            if (detected && detected.encoding && detected.confidence > 0.8) { // Use if confidence is high
                // Map common names/aliases if needed
                switch (detected.encoding.toLowerCase()) {
                    case 'windows-1254': // Common Turkish encoding
                        detectedEncoding = 'win1254';
                        break;
                    case 'iso-8859-9': // Another common Turkish encoding
                        detectedEncoding = 'iso88599';
                        break;
                    case 'utf-16le':
                        detectedEncoding = 'utf16le';
                        break;
                    case 'utf-16be':
                        detectedEncoding = 'utf16be';
                        break;
                    case 'ascii':
                        detectedEncoding = 'utf8'; // Treat ASCII as UTF-8
                        break;
                    case 'utf-8':
                    case 'utf8':
                         detectedEncoding = 'utf8';
                         break;
                    // Add more mappings if necessary based on jschardet results
                    default:
                        detectedEncoding = detected.encoding;
                }
                console.log(`Detected encoding: ${detected.encoding} (confidence: ${detected.confidence.toFixed(2)}), using: ${detectedEncoding}`);
            } else {
                console.log(`Encoding detection confidence low or failed for ${url}. Defaulting to UTF-8.`);
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
                // Combine text using standard newline (\n)
                text: `${mainSub.text}\n${bestTransSub.text}`
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

// Handle process termination
process.on('SIGINT', () => {
    console.log('Shutting down...');
    if (requestTimer) {
        clearInterval(requestTimer);
    }
    process.exit(0);
});

// --- Main Async IIFE to handle ESM import and setup ---
(async () => {
    try {
        // Dynamically import the ESM module
        const { default: SRTParser2 } = await import('srt-parser-2');
        console.log("Successfully imported srt-parser-2.");

        // --- Parser Dependent Helpers (Define inside IIFE) ---

        // Formats an array of subtitle objects back into SRT text
        function formatSrt(subtitleArray) {
            if (!Array.isArray(subtitleArray)) {
                 console.error("Invalid input to formatSrt: not an array.");
                 return null;
            }
            try {
                const parser = new SRTParser2();
                // Ensure IDs are sequential numbers as strings, as required by srt-parser-2
                const sanitizedArray = subtitleArray.map((sub, index) => ({
                     ...sub,
                     id: (index + 1).toString()
                }));
                return parser.toSrt(sanitizedArray);
            } catch (error) {
                console.error('Error formatting SRT:', error.message);
                // Log the problematic structure if possible
                console.error('Problematic data for formatSrt:', JSON.stringify(subtitleArray.slice(0, 5)));
                return null;
            }
        }

        // Parses SRT text into an array of objects
        function parseSrt(srtText) {
            if (!srtText || typeof srtText !== 'string') {
                 console.error("Invalid input to parseSrt: not a string or empty.");
                 return null;
            }
            try {
                const parser = new SRTParser2();
                // Pre-process: remove BOM if present (should be handled by fetch, but double-check)
                if(srtText.charCodeAt(0) === 0xFEFF) {
                     console.log("Found BOM in parseSrt, removing it.");
                     srtText = srtText.substring(1);
                }
                // Pre-process: normalize line endings
                srtText = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

                const subtitles = parser.fromSrt(srtText);

                if (!Array.isArray(subtitles)) {
                     console.error("Parsing did not return an array.");
                     return null;
                }
                 if (subtitles.length === 0 && srtText.trim().length > 0) {
                     console.warn("Parsing resulted in an empty array despite non-empty input.");
                     return null; // Treat as parse failure if input wasn't just whitespace
                 }
                 if (subtitles.length > 0 && (!subtitles[0].startTime || !subtitles[0].text)) {
                     console.warn("Parsed structure seems invalid (missing startTime or text in first entry).");
                     return null;
                 }

                console.log(`Parsed ${subtitles.length} subtitle entries.`);
                return subtitles;
            } catch (error) {
                console.error('Error parsing SRT:', error.message);
                console.error('Problematic SRT start:\n' + srtText.substring(0, 300));
                return null;
            }
        }

        // --- Define Addon Handler (Inside IIFE) ---
        builder.defineSubtitlesHandler(async ({ type, id, extra, config }) => {
            console.log('Dual Subtitle request:', { type, id, extra });
            console.log('Config:', config);

            // Get selected languages from config, with defaults
            const mainLang = config?.mainLang || 'eng';
            const transLang = config?.transLang || 'tur';
            const isWebVersion = config?.version === 'web';

            console.log(`Selected Languages: Main=${mainLang}, Translation=${transLang}`);
            console.log(`Using ${isWebVersion ? 'WEB' : 'DESKTOP'} version settings.`);

            // Parse the IMDB ID
            let imdbId = extra?.imdbId || id;
            let season = extra?.season;
            let episode = extra?.episode;

            // Handle combined series ID format (e.g., tt12345:1:2)
            if (imdbId.includes(':')) {
                const parts = imdbId.split(':');
                imdbId = parts[0];
                if (parts.length >= 3) {
                    season = season || parts[1];
                    episode = episode || parts[2];
                }
            }

            if (!imdbId || !imdbId.startsWith('tt')) {
                console.log('No valid IMDB ID provided');
                return { subtitles: [] };
            }

            // Prepare base search parameters (without language)
            const baseSearchParams = {
                imdbid: imdbId.replace('tt', '')
            };
            if (type === 'series' && season && episode) {
                baseSearchParams.season = season;
                baseSearchParams.episode = episode;
            }

            try {
                // Fetch subtitles metadata for both languages concurrently
                console.log("Fetching subtitle metadata for both languages...");
                const [mainSubInfo, transSubInfo] = await Promise.all([
                    fetchAndSelectSubtitle(mainLang, baseSearchParams, isWebVersion),
                    fetchAndSelectSubtitle(transLang, baseSearchParams, isWebVersion)
                ]);

                // Check if we got metadata for both
                if (!mainSubInfo || !transSubInfo) {
                     console.log("Could not find subtitle metadata for both requested languages.");
                     // Try returning only main if found
                     if (mainSubInfo?.url) {
                          console.warn("Could not get translation metadata. Attempting to return only main subtitle.");
                          const mainContentAlone = await fetchSubtitleContent(mainSubInfo.url);
                          if (mainContentAlone) {
                              // Use Base64 encoding for the Data URI
                              const mainDataUriAlone = `data:application/x-subrip;base64,${Buffer.from(mainContentAlone).toString('base64')}`;
                              return {
                                 subtitles: [{
                                     id: mainSubInfo.id,
                                     url: mainDataUriAlone,
                                     lang: mainLang,
                                     name: `[${mainLang.toUpperCase()}] ${mainSubInfo.releaseName || 'Main Subtitle'} (No Translation Found)`
                                  }],
                                 cacheMaxAge: 3600
                              };
                          }
                     }
                     return { subtitles: [], cacheMaxAge: 60 }; // Cache failure briefly
                }

                console.log(`Selected Main Subtitle (${mainLang}): ID=${mainSubInfo.id}, Lang=${mainSubInfo.langName}, Rating=${mainSubInfo.rating}, Format=${mainSubInfo.format}, URL=${mainSubInfo.url}`);
                console.log(`Selected Translation Subtitle (${transLang}): ID=${transSubInfo.id}, Lang=${transSubInfo.langName}, Rating=${transSubInfo.rating}, Format=${transSubInfo.format}, URL=${transSubInfo.url}`);

                 // --- Fetch Content, Parse, Merge ---
                 console.log("Fetching subtitle content...");
                 const [mainSubContent, transSubContent] = await Promise.all([
                     fetchSubtitleContent(mainSubInfo.url),
                     fetchSubtitleContent(transSubInfo.url)
                 ]);

                 if (!mainSubContent || !transSubContent) {
                     console.error("Failed to fetch content for one or both subtitles.");
                      // Try returning only main if content available
                      if (mainSubContent && mainSubInfo?.url) {
                           console.warn("Failed to fetch translation content. Returning only main subtitle.");
                           const mainDataUriAlone = `data:application/x-subrip;base64,${Buffer.from(mainSubContent).toString('base64')}`;
                           return {
                              subtitles: [{
                                  id: mainSubInfo.id,
                                  url: mainDataUriAlone,
                                  lang: mainLang,
                                  name: `[${mainLang.toUpperCase()}] ${mainSubInfo.releaseName || 'Main Subtitle'} (Translation Fetch Failed)`
                               }],
                              cacheMaxAge: 3600
                           };
                      }
                     return { subtitles: [], cacheMaxAge: 60 };
                 }

                 console.log("Parsing subtitles...");
                 if (mainSubInfo.format?.toLowerCase() !== 'srt' || transSubInfo.format?.toLowerCase() !== 'srt') {
                     console.warn(`One or both subtitles are not SRT (${mainSubInfo.format}, ${transSubInfo.format}). Merging assumes SRT structure. Results may be inaccurate.`);
                 }

                 // Now call the parseSrt defined within the IIFE scope
                 const mainParsed = parseSrt(mainSubContent);
                 const transParsed = parseSrt(transSubContent);

                 if (!mainParsed || !transParsed) {
                     console.error("Failed to parse one or both subtitles.");
                      if (mainParsed && mainSubInfo?.url) {
                          console.warn("Translation subtitle failed parsing. Returning only the main subtitle.");
                            const formattedMain = formatSrt(mainParsed);
                            if (formattedMain) {
                                 const mainSubDataUri = `data:application/x-subrip;base64,${Buffer.from(formattedMain).toString('base64')}`;
                                 return {
                                     subtitles: [{
                                         id: mainSubInfo.id,
                                         url: mainSubDataUri,
                                         lang: mainLang,
                                         name: `[${mainLang.toUpperCase()}] ${mainSubInfo.releaseName || 'Main Subtitle'} (Translation Parse Failed)`
                                      }],
                                     cacheMaxAge: 3600
                                  };
                            } else {
                                 console.error("Failed to re-format main subtitle after translation parse failure.");
                            }
                      }
                     return { subtitles: [], cacheMaxAge: 60 };
                 }

                 console.log("Merging subtitles...");
                 // Call mergeSubtitles (defined outside IIFE)
                 const mergedParsed = mergeSubtitles(mainParsed, transParsed);

                 if (!mergedParsed || mergedParsed.length === 0) {
                     console.error("Merging resulted in empty subtitles.");
                     return { subtitles: [], cacheMaxAge: 60 };
                 }

                 console.log("Formatting merged subtitles to SRT...");
                 // Call formatSrt (defined inside IIFE)
                 const mergedSrtString = formatSrt(mergedParsed);

                 if (!mergedSrtString) {
                     console.error("Failed to format merged subtitles back to SRT.");
                     return { subtitles: [], cacheMaxAge: 60 };
                 }

                 console.log("Creating Data URI for merged subtitles...");
                 const mergedSubDataUri = `data:application/x-subrip;base64,${Buffer.from(mergedSrtString).toString('base64')}`;

                 // Return the single merged subtitle entry
                 return {
                     subtitles: [{
                         id: `merged-${mainSubInfo.id}-${transSubInfo.id}`,
                         url: mergedSubDataUri,
                         lang: `${mainLang}+${transLang}`, // Custom lang code for dual subs
                         name: `[${mainLang.toUpperCase()}/${transLang.toUpperCase()}] Dual Subtitle`
                     }],
                     cacheMaxAge: 6 * 3600, // Cache for 6 hours
                     staleRevalidate: 24 * 3600 // Allow stale for 1 day
                 };
                 // --- End Merging Logic ---

            } catch (error) {
                console.error('Error in subtitle handler:', error.message, error.stack);
                return { subtitles: [], cacheMaxAge: 60 }; // Cache failure briefly
            }
        });

        // --- Start Server (Inside IIFE) ---
        serveHTTP(builder.getInterface(), { port: ADDON_PORT });
        console.log(`Dual Language Subtitles Addon running at ${ADDON_URL}/manifest.json`);
        console.log(`To install in Stremio, open: stremio://addon/${encodeURIComponent(ADDON_URL)}/manifest.json`);
        console.log(`After installation, click the "Configure" button to select Main and Translation languages.`);

    } catch (err) {
        console.error("Failed to import srt-parser-2 or setup addon:", err);
        process.exit(1); // Exit if essential import fails
    }
})();

console.log("Addon script initialized. Waiting for ESM import and server start..."); // Log outside IIFE 