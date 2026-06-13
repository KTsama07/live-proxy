const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const https = require('https'); // built-in — no extra dependency needed

const app = express();
const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:8000';

// ─── Upstream config ──────────────────────────────────────────────────────────
const UPSTREAM_HOST = '3cup-live.s3.eu-west-3.amazonaws.com';
const SPOOF_ORIGIN  = 'https://zz.depoooo.com';

// ─── Cache config ─────────────────────────────────────────────────────────────
//
// HLS has two file types with very different caching needs:
//
//   .m3u8  →  Playlist files. Change every ~6s on a live stream.
//             Cache for 6s so all concurrent viewers share ONE upstream fetch
//             but still get fresh playlists each segment cycle.
//
//   .ts    →  Video segments. IMMUTABLE once written — the same URL always
//             returns the same bytes. Safe to cache for 60s.
//             With 10 viewers, 10 requests → 1 upstream fetch. 10× savings.
//
const PLAYLIST_TTL_MS  = 1000; // 1 second (keeps live stream fresh)
const SEGMENT_TTL_MS   = 60 * 1000; // 60 seconds
const MAX_CACHE_BYTES  = 150 * 1024 * 1024; // 150 MB max — fits Azure Container Apps 512MB instance

// ─── Cache store ──────────────────────────────────────────────────────────────
// Structure: Map<path, { data: Buffer, contentType: string, expiresAt: number, size: number }>
const cache       = new Map();
let   cacheSizeBytes = 0;

function getCached(path) {
    const entry = cache.get(path);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        // Expired — evict it
        cacheSizeBytes -= entry.size;
        cache.delete(path);
        return null;
    }
    return entry;
}

function setCached(path, data, contentType, ttl) {
    const size = data.length;

    // Evict oldest entries until we're under the memory limit
    while (cacheSizeBytes + size > MAX_CACHE_BYTES && cache.size > 0) {
        const oldestKey   = cache.keys().next().value;
        const oldestEntry = cache.get(oldestKey);
        cacheSizeBytes   -= oldestEntry.size;
        cache.delete(oldestKey);
        console.log(`[CACHE EVICT] ${oldestKey} (freed ${(oldestEntry.size / 1024).toFixed(1)} KB)`);
    }

    cache.set(path, { data, contentType, expiresAt: Date.now() + ttl, size });
    cacheSizeBytes += size;
}

// ─── Request coalescing ───────────────────────────────────────────────────────
// If 10 viewers all request the same uncached segment simultaneously,
// we want ONE upstream request — not 10. We track in-flight requests here.
const inflight = new Map(); // Map<path, Promise<{statusCode, contentType, data}>>

function fetchUpstream(upstreamPath) {
    // Return the existing in-flight promise if one already exists for this path
    if (inflight.has(upstreamPath)) {
        console.log(`[COALESCE]   ${upstreamPath}`);
        return inflight.get(upstreamPath);
    }

    const promise = new Promise((resolve, reject) => {
        const options = {
            hostname: UPSTREAM_HOST,
            path:     upstreamPath,
            method:   'GET',
            headers:  {
                'Origin':     SPOOF_ORIGIN,
                'Referer':    SPOOF_ORIGIN + '/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data',  (chunk) => chunks.push(chunk));
            res.on('end',   ()      => resolve({
                statusCode:  res.statusCode,
                contentType: res.headers['content-type'] || 'application/octet-stream',
                data:        Buffer.concat(chunks),
            }));
        });

        req.on('error', reject);
        req.setTimeout(10000, () => { req.destroy(new Error('Upstream timeout')); });
        req.end();
    });

    // Register and clean up the in-flight tracker
    inflight.set(upstreamPath, promise);
    promise.finally(() => inflight.delete(upstreamPath));

    return promise;
}

// ─── Security middleware ───────────────────────────────────────────────────────
const ALLOWED_PATH = /^\/proxy\/[a-zA-Z0-9_\-\/]+\.(m3u8|ts)$/;

app.use(cors({ origin: ALLOWED_ORIGIN, methods: ['GET', 'OPTIONS'] }));

app.use('/proxy', rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests.' },
}));

app.use('/proxy', (req, res, next) => {
    if (!ALLOWED_PATH.test('/proxy' + req.path)) return res.status(403).json({ error: 'Forbidden.' });
    if (req.method !== 'GET' && req.method !== 'OPTIONS') return res.status(405).json({ error: 'Method not allowed.' });
    next();
});

// ─── Main proxy + cache handler ───────────────────────────────────────────────
app.get('/proxy/*', async (req, res) => {
    const proxyPath    = req.path.replace(/^\/proxy/, ''); // /proxy/max1/seg.ts → /max1/seg.ts
    const isPlaylist   = proxyPath.endsWith('.m3u8');
    const ttl          = isPlaylist ? PLAYLIST_TTL_MS : SEGMENT_TTL_MS;

    // ── 1. Cache hit ────────────────────────────────────────────────────────
    const cached = getCached(proxyPath);
    if (cached) {
        console.log(`[CACHE HIT]  ${proxyPath} (${(cached.size / 1024).toFixed(1)} KB)`);
        res.setHeader('Content-Type',                cached.contentType);
        res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        res.setHeader('X-Cache',                     'HIT');
        res.setHeader('X-Content-Type-Options',      'nosniff');
        res.setHeader('Cache-Control', isPlaylist ? 'no-store' : 'public, max-age=60');
        return res.send(cached.data);
    }

    // ── 2. Cache miss — fetch from upstream (coalesced) ────────────────────
    console.log(`[CACHE MISS] ${proxyPath}`);
    try {
        const upstream = await fetchUpstream(proxyPath);

        if (upstream.statusCode !== 200) {
            return res.status(upstream.statusCode).json({ error: 'Upstream error.' });
        }

        // Store in cache for future viewers
        setCached(proxyPath, upstream.data, upstream.contentType, ttl);

        console.log(`[CACHE SET]  ${proxyPath} TTL=${ttl / 1000}s size=${(upstream.data.length / 1024).toFixed(1)}KB | cache=${(cacheSizeBytes / 1024 / 1024).toFixed(1)}MB / ${MAX_CACHE_BYTES / 1024 / 1024}MB`);

        res.setHeader('Content-Type',                upstream.contentType);
        res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        res.setHeader('X-Cache',                     'MISS');
        res.setHeader('X-Content-Type-Options',      'nosniff');
        res.setHeader('Cache-Control', isPlaylist ? 'no-store' : 'public, max-age=60');
        res.send(upstream.data);

    } catch (err) {
        console.error('[UPSTREAM ERROR]', err.message);
        res.status(502).json({ error: 'Stream unavailable.' });
    }
});

// ─── Cache stats endpoint (internal monitoring only) ──────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status:       'ok',
        cacheEntries: cache.size,
        cacheMB:      (cacheSizeBytes / 1024 / 1024).toFixed(2),
        maxMB:        MAX_CACHE_BYTES / 1024 / 1024,
        inflightReqs: inflight.size,
    });
});

// ─── 404 catch-all ────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.listen(PORT, () => {
    console.log(`CORS Proxy running on port ${PORT}`);
    console.log(`Allowed origin  : ${ALLOWED_ORIGIN}`);
    console.log(`Cache limit     : ${MAX_CACHE_BYTES / 1024 / 1024} MB`);
    console.log(`Playlist TTL    : ${PLAYLIST_TTL_MS / 1000}s`);
    console.log(`Segment TTL     : ${SEGMENT_TTL_MS  / 1000}s`);
});
