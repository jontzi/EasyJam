import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';

dotenv.config({ quiet: true });

export const config = {
  port: Number(process.env.PORT ?? 5050),
  databasePath: process.env.DATABASE_PATH ?? './data/easyjam.sqlite',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID ?? '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? '',
  spotifyRedirectUri:
    process.env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:5050/api/auth/callback',
  spotifyPlaylistId: process.env.SPOTIFY_PLAYLIST_ID || null,
  adminAccessKey: process.env.ADMIN_ACCESS_KEY || null,
  autoStartPlayback: process.env.AUTO_START_PLAYBACK !== 'false',
  easyJamEnabled: false,
  playbackControlMode: 'external',
  handoffLeadMs: 2_000
};

export function setPlaybackControlMode(value) {
  const normalized = value === 'easyjam' ? 'easyjam' : 'external';
  config.playbackControlMode = normalized;
  return normalized;
}

export function setHandoffLeadMs(value) {
  const normalized = Math.min(Math.max(Math.round(Number(value) / 500) * 500, 0), 10_000);
  config.handoffLeadMs = Number.isFinite(normalized) ? normalized : 2_000;
  return config.handoffLeadMs;
}

export function hasSpotifyCredentials() {
  return Boolean(config.spotifyClientId && config.spotifyClientSecret);
}

function serializeEnvValue(value) {
  return String(value ?? '').replace(/\r?\n/g, '').trim();
}

async function updateEnvFile(nextValues) {
  const envPath = path.resolve(process.cwd(), '.env');
  let existing = '';
  try {
    existing = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const lines = existing ? existing.split(/\r?\n/) : [];
  const consumedKeys = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !(match[1] in nextValues)) return line;

    consumedKeys.add(match[1]);
    return `${match[1]}=${nextValues[match[1]]}`;
  });

  for (const [key, value] of Object.entries(nextValues)) {
    if (!consumedKeys.has(key)) nextLines.push(`${key}=${value}`);
  }

  await fs.writeFile(envPath, `${nextLines.join('\n').trim()}\n`, 'utf8');
}

export async function saveSpotifySetup({
  spotifyClientId,
  spotifyClientSecret,
  spotifyRedirectUri,
  frontendUrl,
  adminAccessKey
}) {
  const nextValues = {
    SPOTIFY_CLIENT_ID: serializeEnvValue(spotifyClientId),
    SPOTIFY_CLIENT_SECRET: serializeEnvValue(spotifyClientSecret),
    SPOTIFY_REDIRECT_URI:
      serializeEnvValue(spotifyRedirectUri) || config.spotifyRedirectUri,
    FRONTEND_URL: serializeEnvValue(frontendUrl) || config.frontendUrl,
    ADMIN_ACCESS_KEY: serializeEnvValue(adminAccessKey) || config.adminAccessKey || ''
  };

  if (!nextValues.SPOTIFY_CLIENT_ID || !nextValues.SPOTIFY_CLIENT_SECRET) {
    const error = new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required');
    error.status = 400;
    throw error;
  }

  await updateEnvFile(nextValues);

  config.spotifyClientId = nextValues.SPOTIFY_CLIENT_ID;
  config.spotifyClientSecret = nextValues.SPOTIFY_CLIENT_SECRET;
  config.spotifyRedirectUri = nextValues.SPOTIFY_REDIRECT_URI;
  config.frontendUrl = nextValues.FRONTEND_URL;
  config.adminAccessKey = nextValues.ADMIN_ACCESS_KEY || null;

  return {
    spotifyRedirectUri: config.spotifyRedirectUri,
    frontendUrl: config.frontendUrl,
    adminAccessConfigured: Boolean(config.adminAccessKey)
  };
}

export async function saveSpotifyPlaylistId(playlistId) {
  const nextPlaylistId = serializeEnvValue(playlistId);
  if (!nextPlaylistId) {
    const error = new Error('SPOTIFY_PLAYLIST_ID is required');
    error.status = 400;
    throw error;
  }

  await updateEnvFile({ SPOTIFY_PLAYLIST_ID: nextPlaylistId });
  config.spotifyPlaylistId = nextPlaylistId;
  return { spotifyPlaylistId: config.spotifyPlaylistId };
}

export async function saveAutoStartPlayback(enabled) {
  const nextValue = Boolean(enabled);
  await updateEnvFile({ AUTO_START_PLAYBACK: String(nextValue) });
  config.autoStartPlayback = nextValue;
  return { autoStartPlayback: config.autoStartPlayback };
}

export const spotifyScopes = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-modify-private',
  'playlist-modify-public',
  'playlist-read-private',
  'playlist-read-collaborative'
];
