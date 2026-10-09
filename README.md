---
title: Torrentio GDrive
emoji: 🎬
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# Torrentio-GDrive (Stremio & Nuvio Debrid Addon)

1:1 Torrentio clone that transforms your personal **5 TB Google Drive** into a private, high-speed **Debrid Cache & Sequential Streaming Engine**.

## Features

- **1:1 Torrentio Experience**: Full scraped torrent lists (4K Remux, HDR, Dolby Vision, seeders).
- **Google Drive as Debrid**: Cached items marked with `[GDrive+]` and played at 1 Gbps+ HTTP 206 Range streams.
- **Sequential Streaming Engine**: Uncached items start playback within 5-10 seconds via WebTorrent while piping directly into Google Drive in the background.
- **Tracker Booster**: 100+ Tier-1 public trackers + DHT/PEX injected into swarms.
- **Zero Local Disk Wear**: Direct RAM/pipe upload to Google Drive Resumable Upload API.
- **Manual Quota Management**: Delete watched movies anytime directly from `drive.google.com` in `/Stremio` folder.
- **Dual Client Support**: Works simultaneously in both **Stremio** and **Nuvio** (Novio).
