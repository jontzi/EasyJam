import fs from 'node:fs/promises';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { config } from './config.js';
import {
  hydratePersistentState,
  partyState,
  setPersistedHostPlaylistId
} from './state.js';

let db;

async function readJsonState(key, fallback) {
  const row = await db.get('SELECT value FROM app_state WHERE key = ?', key);
  if (!row?.value) return fallback;

  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

async function writeJsonState(key, value) {
  await db.run(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value)
  );
}

export async function initStorage() {
  const databasePath = path.resolve(process.cwd(), config.databasePath);
  await fs.mkdir(path.dirname(databasePath), { recursive: true });

  db = await open({
    filename: databasePath,
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS guest_playlists (
      guest_id TEXT PRIMARY KEY,
      playlists TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS played_tracks (
      id TEXT PRIMARY KEY,
      track_id TEXT NOT NULL,
      track_uri TEXT NOT NULL,
      track_name TEXT NOT NULL,
      track_artists TEXT NOT NULL,
      track_album TEXT NOT NULL,
      track_image TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      explicit INTEGER NOT NULL DEFAULT 0,
      guest_id TEXT NOT NULL,
      guest_name TEXT,
      requester_type TEXT,
      jam_id TEXT,
      requested_at TEXT,
      played_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_played_tracks_played_at
      ON played_tracks (played_at DESC);
  `);

  const playedTrackColumns = await db.all('PRAGMA table_info(played_tracks)');
  if (!playedTrackColumns.some((column) => column.name === 'guest_name')) {
    await db.exec('ALTER TABLE played_tracks ADD COLUMN guest_name TEXT');
  }
  if (!playedTrackColumns.some((column) => column.name === 'requested_at')) {
    await db.exec('ALTER TABLE played_tracks ADD COLUMN requested_at TEXT');
  }
  if (!playedTrackColumns.some((column) => column.name === 'requester_type')) {
    await db.exec('ALTER TABLE played_tracks ADD COLUMN requester_type TEXT');
  }
  if (!playedTrackColumns.some((column) => column.name === 'jam_id')) {
    await db.exec('ALTER TABLE played_tracks ADD COLUMN jam_id TEXT');
  }

  const invite = await readJsonState('invite', null);
  const pinnedPlaylists = await readJsonState('pinnedPlaylists', []);
  const randomFallback = await readJsonState('randomFallback', null);
  const leaderboardResetAt = await readJsonState('leaderboardResetAt', null);
  const hostPlaylistId = await readJsonState('hostPlaylistId', null);
  const autoStartPlayback = await readJsonState('autoStartPlayback', null);
  const handoffLeadMs = await readJsonState('handoffLeadMs', null);
  const livePartyState = await readJsonState('livePartyState', null);
  const playbackHistory = await getPlayedTrackLog({ limit: 100 });
  hydratePersistentState({
    invite,
    pinnedPlaylists,
    randomFallback,
    leaderboardResetAt,
    livePartyState,
    playbackHistory
  });
  if (hostPlaylistId) {
    setPersistedHostPlaylistId(hostPlaylistId);
  }
  if (typeof autoStartPlayback === 'boolean') {
    config.autoStartPlayback = autoStartPlayback;
  } else {
    config.autoStartPlayback = true;
  }
  if (typeof handoffLeadMs === 'number' && Number.isFinite(handoffLeadMs)) {
    config.handoffLeadMs = Math.min(Math.max(Math.round(Number(handoffLeadMs) / 500) * 500, 0), 10_000);
  }

  if (!invite?.jamId) await saveInviteState();
  if (!pinnedPlaylists.length) await savePinnedPlaylists();
  if (!randomFallback) await saveRandomFallbackState();
  if (!hostPlaylistId && partyState.host.playlistId) await saveHostPlaylistState();
  if (typeof autoStartPlayback !== 'boolean') await saveAutoStartPlaybackState();
  if (!(typeof handoffLeadMs === 'number' && Number.isFinite(handoffLeadMs))) {
    await saveHandoffLeadState();
  }
  if (!livePartyState) await saveLivePartyState();
}

export async function saveInviteState() {
  await writeJsonState('invite', {
    token: partyState.invite.token,
    jamId: partyState.invite.jamId,
    pinHash: partyState.invite.pinHash,
    pinEnabled: partyState.invite.pinEnabled,
    guestsCanInvite: partyState.invite.guestsCanInvite,
    playlistLinksEnabled: partyState.invite.playlistLinksEnabled
  });
}

export async function savePinnedPlaylists() {
  await writeJsonState('pinnedPlaylists', partyState.pinnedPlaylists);
}

export async function saveRandomFallbackState() {
  await writeJsonState('randomFallback', partyState.randomFallback);
}

export async function saveLeaderboardResetState() {
  await writeJsonState('leaderboardResetAt', partyState.leaderboardResetAt);
}

export async function saveHostPlaylistState() {
  await writeJsonState('hostPlaylistId', partyState.host.playlistId ?? null);
}

export async function saveAutoStartPlaybackState() {
  await writeJsonState('autoStartPlayback', Boolean(config.autoStartPlayback));
}

export async function saveHandoffLeadState() {
  await writeJsonState('handoffLeadMs', config.handoffLeadMs);
}

export async function saveLivePartyState() {
  await writeJsonState('livePartyState', {
    guests: [...partyState.guests.values()],
    guestOrder: partyState.guestOrder,
    bannedGuests: [...partyState.bannedGuests.values()],
    queueMode: partyState.queueMode,
    manualOrder: partyState.manualOrder,
    currentItemId: partyState.playback.currentItemId
  });
}

export async function savePlayedTrack(historyItem) {
  if (!historyItem?.id || !historyItem?.track?.id || !historyItem?.track?.uri) return;

  // Append-only audit log. Do not prune this table from application code.
  await db.run(
    `INSERT OR IGNORE INTO played_tracks (
      id,
      track_id,
      track_uri,
      track_name,
      track_artists,
      track_album,
      track_image,
      duration_ms,
      explicit,
      guest_id,
      guest_name,
      requester_type,
      jam_id,
      requested_at,
      played_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    historyItem.id,
    historyItem.track.id,
    historyItem.track.uri,
    historyItem.track.name,
    JSON.stringify(historyItem.track.artists ?? []),
    historyItem.track.album ?? '',
    historyItem.track.image ?? null,
    Number(historyItem.track.durationMs ?? 0),
    historyItem.track.explicit ? 1 : 0,
    historyItem.guestId,
    historyItem.guestName ?? null,
    historyItem.requesterType ?? (historyItem.guestId === 'spotify' ? 'spotify' : 'visitor'),
    historyItem.jamId ?? partyState.invite.jamId,
    historyItem.requestedAt ?? historyItem.addedAt,
    historyItem.addedAt
  );
}

export async function getPlayedTrackLog({
  limit = 100,
  offset = 0,
  all = false,
  from = null,
  to = null
} = {}) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const normalizedOffset = Math.max(Number(offset) || 0, 0);
  const filters = [];
  const parameters = [];
  if (Number.isFinite(Date.parse(from || ''))) {
    filters.push('played_at >= ?');
    parameters.push(new Date(from).toISOString());
  }
  if (Number.isFinite(Date.parse(to || ''))) {
    filters.push('played_at < ?');
    parameters.push(new Date(to).toISOString());
  }
  const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
  const sql = `SELECT
      id,
      track_id,
      track_uri,
      track_name,
      track_artists,
      track_album,
      track_image,
      duration_ms,
      explicit,
      guest_id,
      guest_name,
      requester_type,
      jam_id,
      requested_at,
      played_at
    FROM played_tracks${where}
    ORDER BY played_at DESC`;
  const rows = all
    ? await db.all(sql, ...parameters)
    : await db.all(
        `${sql} LIMIT ? OFFSET ?`,
        ...parameters,
        normalizedLimit,
        normalizedOffset
      );

  return rows.map((row) => ({
    id: row.id,
    track: {
      id: row.track_id,
      uri: row.track_uri,
      name: row.track_name,
      artists: parseJsonArray(row.track_artists),
      album: row.track_album,
      image: row.track_image,
      durationMs: Number(row.duration_ms ?? 0),
      explicit: Boolean(row.explicit)
    },
    guestId: row.guest_id,
    guestName: row.guest_name ?? null,
    requesterType: row.requester_type ?? (row.guest_id === 'spotify' ? 'spotify' : 'visitor'),
    jamId: row.jam_id ?? null,
    requestedAt: row.requested_at ?? row.played_at,
    addedAt: row.played_at
  }));
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getGuestPlaylists(guestId) {
  const row = await db.get(
    'SELECT playlists FROM guest_playlists WHERE guest_id = ?',
    guestId
  );
  if (!row?.playlists) return [];

  try {
    return JSON.parse(row.playlists);
  } catch {
    return [];
  }
}

function normalizeSavedPlaylistTrack(track) {
  const uri = String(track?.uri ?? '');
  const id = String(track?.id ?? uri.split(':').pop() ?? '');
  if (!id || !uri.startsWith('spotify:track:')) return null;

  return {
    id,
    uri,
    name: String(track.name ?? 'Unknown track'),
    artists: Array.isArray(track.artists)
      ? track.artists.map((artist) => String(artist)).filter(Boolean)
      : [],
    album: String(track.album ?? ''),
    image: track.image ? String(track.image) : null,
    durationMs: Math.max(Number(track.durationMs) || 0, 0),
    explicit: Boolean(track.explicit),
    addedAt: track.addedAt ? String(track.addedAt) : null
  };
}

export async function saveGuestPlaylists(guestId, playlists) {
  const normalized = Array.isArray(playlists)
    ? playlists.map((playlist) => ({
        id: String(playlist.id ?? ''),
        name: String(playlist.name ?? ''),
        owner: String(playlist.owner ?? ''),
        image: playlist.image ?? null,
        url: playlist.url ?? null,
        addedAt: playlist.addedAt ? String(playlist.addedAt) : null,
        source: playlist.source === 'import' ? 'import' : 'spotify',
        tracks: playlist.source === 'import' && Array.isArray(playlist.tracks)
          ? playlist.tracks.slice(0, 500).map(normalizeSavedPlaylistTrack).filter(Boolean)
          : undefined
      })).filter((playlist) => playlist.id && playlist.name)
    : [];

  await db.run(
    `INSERT INTO guest_playlists (guest_id, playlists, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(guest_id) DO UPDATE SET
       playlists = excluded.playlists,
       updated_at = excluded.updated_at`,
    guestId,
    JSON.stringify(normalized)
  );

  return normalized;
}
