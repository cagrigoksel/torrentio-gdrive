export const TIER1_TRACKERS = [
  // Best open public trackers
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'udp://tracker.coppersurfer.tk:6969/announce',
  'udp://tracker.openbittorrent.com:80/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://opentor.org:2710/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.bittor.pw:1337/announce',
  'udp://tracker.altrosky.nl:6969/announce',
  'udp://opentracker.i2p.rocks:6969/announce',
  'udp://tracker.qu.ax:6969/announce',
  'udp://tracker.moeking.me:6969/announce',
  'udp://tracker.srv00.com:6969/announce',
  'udp://tracker.dump.cl:6969/announce',
  'udp://p4p.arenabg.com:1337/announce',
  'udp://movies.zsw.ca:6969/announce',
  'udp://inferno.demonoid.is:3391/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.cyberia.is:6969/announce',
  'udp://tracker.t-ru.org:6969/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'udp://bt1.archive.org:6969/announce',
  'udp://bt2.archive.org:6969/announce',
  'udp://retracker.lanta-net.ru:2710/announce',
  'udp://tracker.tryhackx.org:6969/announce',
  'udp://tracker.fnix.net:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
  'udp://tracker.army:6969/announce',

  // HTTP & HTTPS fallbacks
  'http://tracker.openbittorrent.com:80/announce',
  'https://tracker.tamersunion.org:443/announce',
  'http://tracker.dler.org:6969/announce',
  'https://tracker.nanoha.org:443/announce',
  'http://tracker.ipv6tracker.ru:80/announce',
  'http://tracker.renogit.stream:6969/announce',
  'http://tracker.files.fm:6969/announce',
  'http://tracker.corpscorp.online:80/announce',
  'http://tracker.bt4g.com:2095/announce',

  // Anime & specialized trackers
  'http://nyaa.tracker.wf:7777/announce',
  'http://anidex.moe:6969/announce',
  'http://tracker.anirena.com:80/announce',
  'udp://tracker.uw0.xyz:6969/announce',
  'http://share.camoe.cn:8080/announce',
  'http://t.nyaatracker.com:80/announce'
];

export function getAllBoostedTrackers(additionalTrackers = []) {
  const set = new Set([...TIER1_TRACKERS, ...(additionalTrackers || [])]);
  return Array.from(set).filter(Boolean);
}
