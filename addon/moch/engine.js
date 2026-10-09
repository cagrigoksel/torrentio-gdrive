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

export function getTorrentEngine() {
  return client;
}

export async function getOrAddTorrent(infoHash) {
  const hash = infoHash.toLowerCase();
  const existing = client.get(hash);
  if (existing && existing.files && existing.files.length) {
    return existing;
  }

  return new Promise((resolve) => {
    console.log(`WebTorrent adding torrent ${hash} with ${TIER1_TRACKERS.length} announce trackers...`);
    
    const timeout = setTimeout(() => {
      const torrent = client.get(hash);
      if (torrent && torrent.files && torrent.files.length) {
        resolve(torrent);
      } else {
        console.warn(`WebTorrent metadata timeout for ${hash}`);
        resolve(null);
      }
    }, 15000);

    const torrent = client.add(hash, {
      announce: TIER1_TRACKERS,
      destroyStoreOnDestroy: true
    }, (t) => {
      clearTimeout(timeout);
      console.log(`WebTorrent metadata ready for: ${t.name} (${t.files.length} files)`);
      resolve(t);
    });

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

  if (Number.isInteger(fileIndex) && torrent.files[fileIndex]) {
    return torrent.files[fileIndex];
  }

  // Find largest video file as default
  const videoFiles = torrent.files
    .filter(f => isVideo(f.name))
    .sort((a, b) => b.length - a.length);

  return videoFiles[0] || torrent.files[0];
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

    console.log(`Starting background Google Drive upload for "${targetFile.name}" (${(targetFile.length / (1024 * 1024)).toFixed(1)} MB) to folder ${folderId}...`);

    // Create a read stream from the torrent file
    const stream = targetFile.createReadStream();

    const media = {
      mimeType: 'video/x-matroska',
      body: stream
    };

    const fileMetadata = {
      name: targetFile.name,
      parents: [folderId],
      description: infoHash,
      properties: {
        infoHash: infoHash,
        fileIndex: targetFile.name
      }
    };

    const res = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, name, size'
    });

    console.log(`Successfully uploaded to Google Drive! File ID: ${res.data.id} (${res.data.name})`);
    activeJobs.set(infoHash, { torrent, uploading: false, completed: true });
  } catch (err) {
    console.error(`Google Drive upload failed for ${infoHash}:`, err?.message || err);
    activeJobs.set(infoHash, { torrent, uploading: false, error: err });
  }
}
