import WebTorrent from 'webtorrent';
import { TIER1_TRACKERS } from '../lib/trackers.js';
import { getDriveClient, getOrCreateStremioFolder } from './gdrive.js';
import { isVideo } from '../lib/extension.js';

// WebTorrent client instance
const client = new WebTorrent({
  dht: true,
  tracker: true
});

client.on('error', (err) => {
  console.error('WebTorrent client error:', err?.message || err);
});

// Active torrent and upload tasks: infoHash -> { torrent, uploading, completed }
const activeJobs = new Map();

// Active torrents map: infoHash -> Torrent instance
const activeTorrents = new Map();

export function getTorrentEngine() {
  return client;
}

export async function getOrAddTorrent(infoHash) {
  const hash = infoHash.toLowerCase();
  if (activeTorrents.has(hash)) {
    const t = activeTorrents.get(hash);
    if (t.ready && t.files && t.files.length) {
      return t;
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(t.files && t.files.length ? t : null), 20000);
      t.once('ready', () => {
        clearTimeout(timeout);
        resolve(t);
      });
    });
  }

  return new Promise((resolve) => {
    console.log(`WebTorrent adding torrent ${hash} with ${TIER1_TRACKERS.length} announce trackers...`);
    
    const timeout = setTimeout(() => {
      console.warn(`WebTorrent metadata timeout for ${hash}`);
      resolve(null);
    }, 25000);

    const magnetUri = `magnet:?xt=urn:btih:${hash}&${TIER1_TRACKERS.map(tr => 'tr=' + encodeURIComponent(tr)).join('&')}`;
    const torrent = client.add(magnetUri, {
      announce: TIER1_TRACKERS,
      destroyStoreOnDestroy: true,
      maxConns: 120
    }, (t) => {
      try {
        t.deselect(0, t.pieces.length - 1, false);
      } catch (e) {}
      clearTimeout(timeout);
      console.log(`WebTorrent metadata ready for: ${t.name} (${t.files.length} files)`);
      resolve(t);
    });

    activeTorrents.set(hash, torrent);

    torrent.on('error', (err) => {
      console.error('Torrent error:', err?.message || err);
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

export function findTargetVideoFile(torrent, fileIndex) {
  if (!torrent || !torrent.files || !torrent.files.length) {
    return null;
  }

  if (Number.isInteger(fileIndex) && torrent.files[fileIndex] && isVideo(torrent.files[fileIndex].name)) {
    return torrent.files[fileIndex];
  }

  // Find largest video file as default
  const videoFiles = torrent.files
    .filter(f => isVideo(f.name))
    .sort((a, b) => b.length - a.length);

  return videoFiles[0] || torrent.files[0];
}

function readTorrentRange(file, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = file.createReadStream({ start, end });
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

export async function pipeTorrentToGoogleDrive(torrent, targetFile, apiKey) {
  const infoHash = torrent.infoHash.toLowerCase();
  if (activeJobs.has(infoHash) && activeJobs.get(infoHash).uploading) {
    return; // Already uploading
  }

  activeJobs.set(infoHash, { torrent, uploading: true });

  try {
    const { drive } = getDriveClient(apiKey);
    const folderId = await getOrCreateStremioFolder(drive);
    const auth = drive.context._options.auth;
    const headers = await auth.getRequestHeaders();

    const totalSize = targetFile.length;
    console.log(`Starting 64MB rolling-chunk upload for "${targetFile.name}" (${(totalSize / (1024**3)).toFixed(2)} GB) to Google Drive /Stremio...`);

    // 1. Create Resumable Upload Session
    const sessionRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true', {
      method: 'POST',
      headers: {
        ...Object.fromEntries(headers.entries()),
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify({
        name: targetFile.name,
        parents: [folderId],
        description: infoHash,
        properties: {
          infoHash: infoHash,
          fileIndex: String(targetFile.name)
        }
      })
    });

    if (!sessionRes.ok) {
      throw new Error(`Failed to initiate resumable upload session: ${sessionRes.statusText}`);
    }

    const sessionUrl = sessionRes.headers.get('location');
    if (!sessionUrl) {
      throw new Error('No resumable session location returned by Google Drive');
    }

    // 2. Rolling Chunks (64 MB buffer in RAM, ZERO bytes on local disk!)
    const CHUNK_SIZE = 64 * 1024 * 1024; // 64 MB (256 KiB aligned)
    let offset = 0;

    while (offset < totalSize) {
      const end = Math.min(offset + CHUNK_SIZE - 1, totalSize - 1);
      const chunkSize = end - offset + 1;

      console.log(`[Rolling Buffer] Fetching chunk [${(offset / (1024*1024)).toFixed(0)} - ${(end / (1024*1024)).toFixed(0)} MB]...`);
      const chunkBuf = await readTorrentRange(targetFile, offset, end);

      const putRes = await fetch(sessionUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(chunkSize),
          'Content-Range': `bytes ${offset}-${end}/${totalSize}`
        },
        body: chunkBuf
      });

      if (putRes.status === 308) {
        offset = end + 1;
        const pct = ((offset / totalSize) * 100).toFixed(1);
        console.log(`[Rolling Buffer] GDrive uploaded: ${pct}% (${(offset / (1024**3)).toFixed(2)} / ${(totalSize / (1024**3)).toFixed(2)} GB)`);
      } else if (putRes.status === 200 || putRes.status === 201) {
        const fileData = await putRes.json();
        console.log(`🎉 Google Drive upload complete! File ID: ${fileData.id} (${fileData.name})`);
        activeJobs.set(infoHash, { torrent, uploading: false, completed: true, fileId: fileData.id });
        break;
      } else {
        throw new Error(`Upload chunk failed with status ${putRes.status} ${putRes.statusText}`);
      }
    }
  } catch (err) {
    console.error(`Google Drive rolling upload failed for ${infoHash}:`, err?.message || err);
    activeJobs.set(infoHash, { torrent, uploading: false, error: err });
  }
}
