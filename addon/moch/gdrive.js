import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { streamFilename, BadTokenError, AccessDeniedError, NotFoundError } from './mochHelper.js';
import { Type } from '../lib/types.js';
import { isVideo } from '../lib/extension.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEY = 'gdrive';
const STREMIO_FOLDER_NAME = 'Stremio';
const CACHE_TTL_MS = 25 * 1000; // 25 seconds cache for folder contents

// In-memory cache: apiKey -> { timestamp, folderId, files: Map(hashOrName -> file) }
const driveCache = new Map();

export function parseCredentials(apiKey) {
  if (!apiKey) {
    if (process.env.GDRIVE_REFRESH_TOKEN) {
      return {
        clientId: process.env.GDRIVE_CLIENT_ID,
        clientSecret: process.env.GDRIVE_CLIENT_SECRET,
        refreshToken: process.env.GDRIVE_REFRESH_TOKEN
      };
    }
    return null;
  }

  // Option 1: Base64 JSON
  try {
    const decoded = Buffer.from(apiKey, 'base64').toString('utf8');
    if (decoded.startsWith('{') && decoded.endsWith('}')) {
      const json = JSON.parse(decoded);
      if (json.refreshToken || json.refresh_token) {
        return {
          clientId: json.clientId || json.client_id || process.env.GDRIVE_CLIENT_ID,
          clientSecret: json.clientSecret || json.client_secret || process.env.GDRIVE_CLIENT_SECRET,
          refreshToken: json.refreshToken || json.refresh_token
        };
      }
    }
  } catch (_) {}

  // Option 2: clientId:clientSecret:refreshToken
  if (apiKey.includes(':')) {
    const parts = apiKey.split(':');
    if (parts.length >= 3) {
      return {
        clientId: parts[0],
        clientSecret: parts[1],
        refreshToken: parts.slice(2).join(':')
      };
    }
  }

  // Option 3: Refresh token directly (using env client id & secret)
  return {
    clientId: process.env.GDRIVE_CLIENT_ID,
    clientSecret: process.env.GDRIVE_CLIENT_SECRET,
    refreshToken: apiKey
  };
}

export function getServiceAccountPath() {
  const candidates = [
    process.env.SERVICE_ACCOUNT_KEY_PATH,
    './service_account.json',
    './addon/service_account.json',
    path.join(__dirname, '../service_account.json'),
    path.join(__dirname, '../../service_account.json'),
    path.resolve(process.cwd(), 'service_account.json'),
    path.resolve(process.cwd(), 'addon/service_account.json')
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function getDriveClient(apiKey) {
  // If service_account.json exists or is in env, prefer Service Account for lifetime permanent access!
  const saPath = getServiceAccountPath();
  if (saPath || process.env.SERVICE_ACCOUNT_KEY) {
    const auth = new google.auth.GoogleAuth({
      keyFile: saPath || undefined,
      credentials: process.env.SERVICE_ACCOUNT_KEY ? JSON.parse(process.env.SERVICE_ACCOUNT_KEY) : undefined,
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    const drive = google.drive({ version: 'v3', auth });
    return { drive, oauth2Client: auth };
  }

  const creds = parseCredentials(apiKey);
  if (!creds || !creds.refreshToken) {
    throw BadTokenError;
  }

  const oauth2Client = new google.auth.OAuth2(
    creds.clientId,
    creds.clientSecret,
    'http://localhost:7070/oauth/callback'
  );

  oauth2Client.setCredentials({
    refresh_token: creds.refreshToken
  });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  return { drive, oauth2Client };
}

export async function getOrCreateStremioFolder(drive) {
  // Check shared folders first, then user's root
  const query = `name = '${STREMIO_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const res = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  // Create Stremio folder if not exists
  const folderMetadata = {
    name: STREMIO_FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder'
  };

  const folder = await drive.files.create({
    resource: folderMetadata,
    fields: 'id',
    supportsAllDrives: true
  });

  return folder.data.id;
}

export async function getStremioFiles(apiKey) {
  const now = Date.now();
  const cached = driveCache.get(apiKey);

  if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
    return cached;
  }

  const { drive } = getDriveClient(apiKey);
  const folderId = await getOrCreateStremioFolder(drive);

  // Query all active files in /Stremio folder
  const query = `'${folderId}' in parents and trashed = false`;
  const res = await drive.files.list({
    q: query,
    pageSize: 1000,
    fields: 'files(id, name, size, mimeType, description, properties)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  const files = res.data.files || [];
  const fileMap = new Map();

  for (const file of files) {
    // Index by properties.infoHash if set
    if (file.properties?.infoHash) {
      fileMap.set(file.properties.infoHash.toLowerCase(), file);
    }
    // Index by description if it contains infoHash
    if (file.description && /^[a-fA-F0-9]{40}$/.test(file.description)) {
      fileMap.set(file.description.toLowerCase(), file);
    }
    // Also index by sanitized name
    const cleanName = sanitizeName(file.name);
    fileMap.set(cleanName, file);
  }

  const cacheEntry = {
    timestamp: now,
    folderId,
    files,
    fileMap
  };

  driveCache.set(apiKey, cacheEntry);
  return cacheEntry;
}

function sanitizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export async function getCachedStreams(streams, apiKey) {
  try {
    const { fileMap } = await getStremioFiles(apiKey);

    return streams.reduce((mochStreams, stream) => {
      const filename = streamFilename(stream);
      const cleanStreamName = sanitizeName(filename);
      const cleanTorrentTitle = sanitizeName(stream.title?.split('\n')[0] || '');

      // Check if infoHash or filename exists in user's /Stremio folder
      const matchedFile = fileMap.get(stream.infoHash?.toLowerCase()) ||
                          fileMap.get(cleanStreamName) ||
                          fileMap.get(cleanTorrentTitle);

      const isCached = !!matchedFile;

      mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
        url: `${encodeURIComponent(apiKey)}/${stream.infoHash}/${encodeURIComponent(filename)}/${stream.fileIdx}${matchedFile ? '/' + matchedFile.id : ''}`,
        cached: isCached
      };

      return mochStreams;
    }, {});
  } catch (error) {
    console.error('GDrive getCachedStreams error:', error?.message || error);
    // Fallback: return streams as uncached so user can still initiate download to Drive
    return streams.reduce((mochStreams, stream) => {
      const filename = streamFilename(stream);
      mochStreams[`${stream.infoHash}@${stream.fileIdx}`] = {
        url: `${encodeURIComponent(apiKey)}/${stream.infoHash}/${encodeURIComponent(filename)}/${stream.fileIdx}`,
        cached: false
      };
      return mochStreams;
    }, {});
  }
}

export async function getCatalog(apiKey, catalogId, config) {
  if (config.skip > 0) {
    return [];
  }
  try {
    const { files } = await getStremioFiles(apiKey);
    return files
      .filter(file => isVideo(file.name))
      .map(file => ({
        id: `${KEY}:${file.id}`,
        type: Type.OTHER,
        name: file.name
      }));
  } catch (err) {
    console.warn('GDrive getCatalog error:', err?.message || err);
    return [];
  }
}

export async function getItemMeta(itemId, apiKey) {
  const { drive } = getDriveClient(apiKey);
  const fileRes = await drive.files.get({
    fileId: itemId,
    fields: 'id, name, size, mimeType'
  });
  const file = fileRes.data;

  return {
    id: `${KEY}:${file.id}`,
    type: Type.OTHER,
    name: file.name,
    videos: [{
      id: `${KEY}:${file.id}:0`,
      title: file.name,
      released: new Date().toISOString(),
      streams: [{
        url: `gdrive/stream/${encodeURIComponent(apiKey)}/${file.id}/${encodeURIComponent(file.name)}`
      }]
    }]
  };
}

export async function resolve({ ip, apiKey, infoHash, cachedEntryInfo, fileIndex, host }) {
  console.log(`GDrive resolve: ${infoHash} [${fileIndex}] (cachedEntryInfo: ${cachedEntryInfo})`);

  // Check if we already have the file in GDrive
  let cachedFile = null;
  try {
    const { fileMap } = await getStremioFiles(apiKey);
    const cleanEntry = sanitizeName(cachedEntryInfo);
    cachedFile = fileMap.get(infoHash?.toLowerCase()) || (cleanEntry ? fileMap.get(cleanEntry) : null);
  } catch (e) {
    console.warn('Could not check GDrive cache in resolve:', e?.message || e);
  }

  const cleanFilename = (cachedEntryInfo || 'video.mp4').split('/').pop().replace(/[^\w\.\-\+]/g, '_');
  const safeFilename = encodeURIComponent(cleanFilename);
  const safeApiKey = encodeURIComponent(apiKey);

  if (cachedFile) {
    console.log(`GDrive playing cached file ${cachedFile.id} (${cachedFile.name})`);
    return `${host}/gdrive/stream/${safeApiKey}/${cachedFile.id}/${safeFilename}`;
  }

  // Not in Drive yet: stream live from torrent engine and pipe upload to Drive!
  console.log(`GDrive starting sequential stream and background upload for ${infoHash}`);
  return `${host}/gdrive/stream-torrent/${safeApiKey}/${infoHash}/${fileIndex ?? 0}/${safeFilename}`;
}

export function toCommonError(error) {
  if (error === BadTokenError || error?.message?.includes('invalid_grant') || error?.code === 401) {
    return BadTokenError;
  }
  if (error?.code === 403) {
    return AccessDeniedError;
  }
  return undefined;
}
