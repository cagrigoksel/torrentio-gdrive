import Router from 'router';
import fs from 'fs';
import cors from 'cors';
import rateLimit from "express-rate-limit";
import requestIp from 'request-ip';
import userAgentParser from 'ua-parser-js';
import { createClient } from 'redis'
import { RedisStore } from 'rate-limit-redis'
import addonInterface from './addon.js';
import qs from 'querystring';
import { manifest } from './lib/manifest.js';
import { parseConfiguration } from './lib/configuration.js';
import landingTemplate from './lib/landingTemplate.js';
import * as moch from './moch/moch.js';
import * as gdrive from './moch/gdrive.js';
import { getOrAddTorrent, findTargetVideoFile, pipeTorrentToGoogleDrive } from './moch/engine.js';
import { google } from 'googleapis';
import { recordRateLimiterStoreError } from './lib/metrics.js';

const router = new Router();
export let redisClient = null;
if (process.env.REDIS_URL) {
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => {
    recordRateLimiterStoreError();
    console.error('Redis client error:', err?.message || err);
  });
  redisClient.connect().catch((err) => console.error('Redis initial connect failed:', err?.message || err));
}
const limiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 1 day
  limit: 50000,
  legacyHeaders: false,
  passOnStoreError: true,
  keyGenerator: (req) => requestIp.getClientIp(req),
  ...(redisClient ? {
    store: new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
    })
  } : {})
});
const resolvedUrlMaxAge = 6 * 60 * 60; // 6 hours

router.use(cors())
router.get('/', (_, res) => {
  res.redirect('/configure')
  res.end();
});

router.get(`/lite`, (req, res) => {
  res.redirect(`/lite/configure`)
  res.end();
});

router.get(`/brazuca`, (req, res) => {
  res.redirect(`/brazuca/configure`)
  res.end();
});

router.get('{/:configuration}/configure', (req, res) => {
  const host = `${req.protocol}://${req.headers.host}`;
  const configValues = { ...parseConfiguration(req.params.configuration || ''), host };
  const landingHTML = landingTemplate(manifest(configValues), configValues);
  res.setHeader('content-type', 'text/html');
  res.end(landingHTML);
});

router.get('{/:configuration}/manifest.json', (req, res) => {
  const host = `${req.protocol}://${req.headers.host}`;
  const configValues = { ...parseConfiguration(req.params.configuration || ''), host };
  const manifestBuf = JSON.stringify(manifest(configValues));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(manifestBuf)
});

router.get('{/:configuration}/:resource/:type/:id{/:extra}.json', limiter, (req, res, next) => {
  const { configuration, resource, type, id } = req.params;
  const extra = req.params.extra ? qs.parse(req.url.split('/').pop().slice(0, -5)) : {}
  const ip = requestIp.getClientIp(req);
  const host = `${req.protocol}://${req.headers.host}`;
  const configValues = { ...extra, ...parseConfiguration(configuration), id, type, ip, host };
  addonInterface.get(resource, type, id, configValues)
      .then(resp => {
        const cacheHeaders = {
          cacheMaxAge: 'max-age',
          staleRevalidate: 'stale-while-revalidate',
          staleError: 'stale-if-error'
        };
        const cacheControl = Object.keys(cacheHeaders)
            .map(prop => Number.isInteger(resp[prop]) && cacheHeaders[prop] + '=' + resp[prop])
            .filter(val => !!val).join(', ');

        res.setHeader('Cache-Control', `${cacheControl}, public`);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(resp));
      })
      .catch(err => {
        if (err.noHandler || err?.code === 'NOT_FOUND') {
          if (next) {
            next()
          } else {
            res.writeHead(404);
            res.end(JSON.stringify({ err: 'not found' }));
          }
        } else {
          console.error('handler error', { resource, type, id, err: err?.message || err, cause: err?.cause?.stack || err?.cause?.message });
          res.writeHead(500);
          res.end(JSON.stringify({ err: 'handler error' }));
        }
      });
});

router.get('/resolve/:moch/:apiKey/:infoHash/:cachedEntryInfo/:fileIndex{/:filename}', (req, res) => {
  const userAgent = req.headers['user-agent'] || '';
  const parameters = {
    mochKey: req.params.moch,
    apiKey: req.params.apiKey,
    infoHash: req.params.infoHash.toLowerCase(),
    fileIndex: isNaN(req.params.fileIndex) ? undefined : parseInt(req.params.fileIndex),
    cachedEntryInfo: req.params.cachedEntryInfo,
    ip: requestIp.getClientIp(req),
    host: `${req.protocol}://${req.headers.host}`,
    isBrowser: !userAgent.includes('Stremio') && !!userAgentParser(userAgent).browser.name
  }
  moch.resolve(parameters)
      .then(url => {
        if (!url.startsWith(parameters.host)) {
          res.setHeader('Cache-Control', `max-age=${resolvedUrlMaxAge}, public`);
        }
        res.writeHead(302, { Location: url });
        res.end();
      })
      .catch(error => {
        console.warn('resolve failed', { mochKey: parameters.mochKey, infoHash: parameters.infoHash, err: error?.message || error });
        res.statusCode = 404;
        res.end();
      });
});

// Google Drive Cached Direct Range Stream (HTTP 206)
const handleGdriveStream = async (req, res) => {
  const { apiKey, fileId } = req.params;
  try {
    const { drive } = gdrive.getDriveClient(decodeURIComponent(apiKey));
    const rangeHeader = req.headers.range;

    const meta = await drive.files.get({
      fileId,
      fields: 'id, name, size, mimeType',
      supportsAllDrives: true
    });

    const fileSize = parseInt(meta.data.size, 10);
    const mimeType = meta.data.mimeType || 'video/mp4';

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': mimeType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store'
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const response = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
      );

      const stream = response.data;
      stream.on('error', (err) => {
        // Normal client abort / seek
      });
      res.on('close', () => {
        try { stream.destroy(); } catch (e) {}
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': mimeType,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store'
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const response = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );

      const stream = response.data;
      stream.on('error', (err) => {
        // Normal client abort / seek
      });
      res.on('close', () => {
        try { stream.destroy(); } catch (e) {}
      });
      stream.pipe(res);
    }
  } catch (err) {
    console.error('GDrive stream error:', err?.message || err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Stream error: ' + (err?.message || err));
    }
  }
};

router.get('/gdrive/stream/:apiKey/:fileId', handleGdriveStream);
router.get('/gdrive/stream/:apiKey/:fileId/:filename', handleGdriveStream);
router.head('/gdrive/stream/:apiKey/:fileId', handleGdriveStream);
router.head('/gdrive/stream/:apiKey/:fileId/:filename', handleGdriveStream);

// Sequential WebTorrent Stream + Google Drive Pipe
const handleTorrentStream = async (req, res) => {
  const { apiKey, infoHash, fileIndex } = req.params;
  try {
    const torrent = await getOrAddTorrent(infoHash);
    if (!torrent) {
      res.statusCode = 504;
      res.end('Torrent metadata timeout');
      return;
    }

    const targetFile = findTargetVideoFile(torrent, parseInt(fileIndex, 10));
    if (!targetFile) {
      res.statusCode = 404;
      res.end('File not found in torrent');
      return;
    }

    // Pipe in background to user's Google Drive /Stremio folder
    pipeTorrentToGoogleDrive(torrent, targetFile, decodeURIComponent(apiKey)).catch(e => {
      console.warn('Background GDrive pipe error:', e?.message || e);
    });

    const rangeHeader = req.headers.range;
    const fileSize = targetFile.length;

    let contentType = 'video/mp4';
    const ext = targetFile.name.split('.').pop().toLowerCase();
    if (ext === 'mkv') contentType = 'video/x-matroska';
    else if (ext === 'avi') contentType = 'video/x-msvideo';
    else if (ext === 'webm') contentType = 'video/webm';

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store'
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = targetFile.createReadStream({ start, end });
      stream.on('error', (err) => {
        // Normal client abort / seek
      });
      res.on('close', () => {
        try { stream.destroy(); } catch (e) {}
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store'
      });

      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = targetFile.createReadStream();
      stream.on('error', (err) => {
        // Normal client abort / seek
      });
      res.on('close', () => {
        try { stream.destroy(); } catch (e) {}
      });
      stream.pipe(res);
    }
  } catch (err) {
    console.error('Torrent stream error:', err?.message || err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Torrent stream error: ' + (err?.message || err));
    }
  }
};

router.get('/gdrive/stream-torrent/:apiKey/:infoHash/:fileIndex', handleTorrentStream);
router.get('/gdrive/stream-torrent/:apiKey/:infoHash/:fileIndex/:filename', handleTorrentStream);
router.head('/gdrive/stream-torrent/:apiKey/:infoHash/:fileIndex', handleTorrentStream);
router.head('/gdrive/stream-torrent/:apiKey/:infoHash/:fileIndex/:filename', handleTorrentStream);

// Initiate Google OAuth Flow
router.get('/gdrive/auth', (req, res) => {
  const clientId = process.env.GDRIVE_CLIENT_ID;
  if (!clientId) {
    res.end('GDRIVE_CLIENT_ID environment variable is not configured.');
    return;
  }
  const host = `${req.protocol}://${req.headers.host}`;
  const redirectUri = `${host}/oauth/callback`;
  const scope = encodeURIComponent('https://www.googleapis.com/auth/drive');
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&access_type=offline&prompt=consent`;
  res.writeHead(302, { Location: authUrl });
  res.end();
});

// Google OAuth 2.0 Callback
router.get('/oauth/callback', async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const code = urlObj.searchParams.get('code');
  if (!code) {
    res.end('No authorization code received.');
    return;
  }
  try {
    const clientId = process.env.GDRIVE_CLIENT_ID;
    const clientSecret = process.env.GDRIVE_CLIENT_SECRET;
    const host = `${req.protocol}://${req.headers.host}`;
    const redirectUri = `${host}/oauth/callback`;

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (refreshToken) {
      process.env.GDRIVE_REFRESH_TOKEN = refreshToken;
      try {
        fs.appendFileSync('.env', `\nGDRIVE_REFRESH_TOKEN=${refreshToken}\n`);
        console.log('Saved GDRIVE_REFRESH_TOKEN to .env successfully!');
      } catch (e) {
        console.warn('Could not write token to .env:', e?.message || e);
      }
    }

    const tokenPayload = Buffer.from(JSON.stringify({
      clientId,
      clientSecret,
      refreshToken
    })).toString('base64');

    const stremioUrl = `stremio://${req.headers.host}/gdrive=${encodeURIComponent(tokenPayload)}/manifest.json`;
    const webUrl = `${host}/gdrive=${encodeURIComponent(tokenPayload)}/manifest.json`;

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`
      <html>
      <body style="background:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
        <div style="background:#1e293b;padding:36px;border-radius:16px;text-align:center;max-width:520px;box-shadow:0 20px 40px rgba(0,0,0,0.6);border:1px solid #334155;">
          <div style="font-size:48px;margin-bottom:12px;">🎬</div>
          <h1 style="color:#34d399;margin:0 0 8px 0;font-size:24px;">Google Drive Bağlandı!</h1>
          <p style="color:#94a3b8;font-size:14px;line-height:1.5;">5 TB Google Drive hesabın Torrentio Debrid ile başarıyla eşlendi.</p>
          <a href="${stremioUrl}" style="display:inline-block;background:#6366f1;color:#ffffff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;margin:20px 0;box-shadow:0 4px 12px rgba(99,102,241,0.4);">Stremio'ya Ekle</a>
          <div style="margin-top:16px;text-align:left;background:#0f172a;padding:14px;border-radius:8px;border:1px solid #334155;">
            <p style="font-size:12px;color:#94a3b8;margin:0 0 6px 0;font-weight:600;">Nuvio (Novio) veya Manuel Ekleme Linki:</p>
            <code style="font-size:11px;color:#a78bfa;word-break:break-all;user-select:all;">${webUrl}</code>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.end('Google OAuth Hatasi: ' + (err?.message || err));
  }
});

export default function (req, res) {
  router(req, res, function () {
    res.statusCode = 404;
    res.end();
  });
};
