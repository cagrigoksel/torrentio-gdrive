import { Sequelize } from 'sequelize';
import { observeDb } from './metrics.js';
const Op = Sequelize.Op;

const DATABASE_URI = process.env.DATABASE_URI;

const getSqlOperation = sql => sql.match(/\b(SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1]?.toUpperCase() ?? 'OTHER';
const database = DATABASE_URI ? new Sequelize(DATABASE_URI, {
  benchmark: true,
  logging: (sql, ms) => observeDb(getSqlOperation(sql), (ms ?? 0) / 1000),
  pool: { max: 30, min: 5, idle: 20 * 60 * 1000 }
}) : null;

export function poolStats() {
  const pool = database?.connectionManager?.pool;
  return pool ? { size: pool.size, available: pool.available, using: pool.using, waiting: pool.waiting } : {};
}

const Torrent = database ? database.define('torrent',
    {
      infoHash: { type: Sequelize.STRING(64), primaryKey: true },
      provider: { type: Sequelize.STRING(32), allowNull: false },
      torrentId: { type: Sequelize.STRING(128) },
      title: { type: Sequelize.STRING(256), allowNull: false },
      size: { type: Sequelize.BIGINT },
      type: { type: Sequelize.STRING(16), allowNull: false },
      uploadDate: { type: Sequelize.DATE, allowNull: false },
      seeders: { type: Sequelize.SMALLINT },
      trackers: { type: Sequelize.STRING(4096) },
      languages: { type: Sequelize.STRING(4096) },
      resolution: { type: Sequelize.STRING(16) }
    }
) : null;

const File = database ? database.define('file',
    {
      id: { type: Sequelize.BIGINT, autoIncrement: true, primaryKey: true },
      infoHash: {
        type: Sequelize.STRING(64),
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: { type: Sequelize.INTEGER },
      title: { type: Sequelize.STRING(256), allowNull: false },
      size: { type: Sequelize.BIGINT },
      imdbId: { type: Sequelize.STRING(32) },
      imdbSeason: { type: Sequelize.INTEGER },
      imdbEpisode: { type: Sequelize.INTEGER },
      kitsuId: { type: Sequelize.INTEGER },
      kitsuEpisode: { type: Sequelize.INTEGER }
    },
) : null;

const Subtitle = database ? database.define('subtitle',
    {
      infoHash: {
        type: Sequelize.STRING(64),
        allowNull: false,
        references: { model: Torrent, key: 'infoHash' },
        onDelete: 'CASCADE'
      },
      fileIndex: { type: Sequelize.INTEGER, allowNull: false },
      fileId: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: File, key: 'id' },
        onDelete: 'SET NULL'
      },
      title: { type: Sequelize.STRING(512), allowNull: false },
      size: { type: Sequelize.BIGINT, allowNull: false },
    },
    { timestamps: false }
) : null;

if (database) {
  Torrent.hasMany(File, { foreignKey: 'infoHash', constraints: false });
  File.belongsTo(Torrent, { foreignKey: 'infoHash', constraints: false });
  File.hasMany(Subtitle, { foreignKey: 'fileId', constraints: false });
  Subtitle.belongsTo(File, { foreignKey: 'fileId', constraints: false });
}

export function closeDatabase() {
  return database ? database.close() : Promise.resolve();
}

export function getTorrent(infoHash) {
  if (!Torrent) return Promise.resolve(null);
  return Torrent.findOne({ where: { infoHash: infoHash } });
}

export function getFiles(infoHashes) {
  if (!File) return Promise.resolve([]);
  return File.findAll({
    attributes: ['infoHash', 'title', 'imdbId', 'imdbSeason', 'imdbEpisode'],
    where: { infoHash: { [Op.in]: infoHashes } },
    raw: true
  });
}

export function getImdbIdMovieEntries(imdbId) {
  if (!File) return Promise.resolve([]);
  return File.findAll({
    where: {
      imdbId: { [Op.eq]: imdbId }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}

export function getImdbIdSeriesEntries(imdbId, season, episode) {
  if (!File) return Promise.resolve([]);
  return File.findAll({
    where: {
      imdbId: { [Op.eq]: imdbId },
      imdbSeason: { [Op.eq]: season },
      imdbEpisode: { [Op.eq]: episode }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}

export function getKitsuIdMovieEntries(kitsuId) {
  if (!File) return Promise.resolve([]);
  return File.findAll({
    where: {
      kitsuId: { [Op.eq]: kitsuId }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}

export function getKitsuIdSeriesEntries(kitsuId, episode) {
  if (!File) return Promise.resolve([]);
  return File.findAll({
    where: {
      kitsuId: { [Op.eq]: kitsuId },
      kitsuEpisode: { [Op.eq]: episode }
    },
    include: [Torrent],
    limit: 500,
    order: [
      [Torrent, 'seeders', 'DESC']
    ]
  });
}
