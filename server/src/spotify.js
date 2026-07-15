import crypto from 'node:crypto';
import { config, spotifyScopes } from './config.js';
import {
  beginOptimisticCompletion,
  getCombinedQueue,
  partyState,
  recordPlayback,
  setHostPlaylist,
  setHostTokens,
  setHostUser
} from './state.js';
import { saveLivePartyState, savePlayedTrack } from './storage.js';

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';
const RANDOM_FALLBACK_TRACK_COUNT = 2;
const RANDOM_FALLBACK_PAGE_SIZE = 50;
const FALLBACK_SAFETY_TRACK_COUNT = 2;
const HANDOFF_RESCHEDULE_TOLERANCE_MS = 100;
const PLAYLIST_ITEMS_CACHE_MS = 15 * 60_000;
const RANDOM_FALLBACK_PAGE_CACHE_MS = 5 * 60_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const RATE_LIMIT_JITTER_RATIO = 0.25;
const MIN_HANDOFF_RETRY_MS = 1_000;
const EXTERNAL_PLAYBACK_END_CONFIRMATION_MS = 10_000;
const RECONNECT_PLAYBACK_CHECK_DELAYS_MS = [0, 2_000, 4_000];
const PLAYBACK_SNAPSHOT_CACHE_MS = 10_000;
const EASYJAM_PLAYBACK_CHECK_INTERVAL_MS = 60_000;
const ADMIN_PLAY_PREFLIGHT_MAX_AGE_MS = 60_000;
const SPOTIFY_REQUEST_LOG_LIMIT = 200;
const AUTOMATIC_SYNC_DEBOUNCE_MS = 1_500;
const AUTOMATIC_SYNC_MIN_INTERVAL_MS = 10_000;

let pendingHandoffTimer = null;
let optimisticTrackAdvanceTimer = null;
let optimisticTrackAdvanceForUri = null;
let scheduledSyncTimer = null;
let scheduledSyncOptions = null;
let lastAutomaticSyncAt = 0;
let lastPlaybackMaintenanceCheckAt = 0;
let lastLivePlaybackReadAt = 0;
let spotifyRateLimitedUntil = 0;
let spotifyRateLimitStrikes = 0;
const playlistItemsCache = new Map();
const fallbackPageCache = new Map();
const spotifyRequestLog = [];
const playbackSnapshot = {
  current: null,
  fetchedAt: 0,
  inFlight: null,
  optimistic: false
};

function sanitizeDiagnosticUris(value) {
  if (!Array.isArray(value)) return null;
  return value
    .filter((uri) => typeof uri === 'string' && uri.startsWith('spotify:'))
    .slice(0, 100);
}

function clearOptimisticTrackAdvanceTimer() {
  if (optimisticTrackAdvanceTimer) {
    clearTimeout(optimisticTrackAdvanceTimer);
    optimisticTrackAdvanceTimer = null;
  }
  optimisticTrackAdvanceForUri = null;
}

function findKnownTrack(uri) {
  if (!uri) return null;
  return (
    getCombinedQueue().find((item) => item.track?.uri === uri)?.track ??
    partyState.sync.fallbackTracks.find((track) => track?.uri === uri) ??
    partyState.playback.history.find((item) => item.track?.uri === uri)?.track ??
    null
  );
}

function nextManagedTrack(uri, direction = 'next') {
  const index = partyState.sync.lastPlaylistUris.indexOf(uri);
  if (index < 0) return null;
  const nextIndex = direction === 'previous' ? index - 1 : index + 1;
  return findKnownTrack(partyState.sync.lastPlaylistUris[nextIndex]);
}

function isPlaybackManagedByEasyJam(playback) {
  if (!playback?.isPlaying || !partyState.sync.lastPlaylistUris.includes(playback.track?.uri)) {
    return false;
  }
  if (config.playbackControlMode === 'easyjam') return true;
  return playback.contextUri === `spotify:playlist:${partyState.host.playlistId}`;
}

function setOptimisticPlayback(current) {
  clearOptimisticTrackAdvanceTimer();
  playbackSnapshot.current = current;
  playbackSnapshot.fetchedAt = Date.now();
  playbackSnapshot.optimistic = true;
  scheduleOptimisticTrackAdvance(current);
}

function scheduleOptimisticTrackAdvance(current) {
  if (
    !config.easyJamEnabled ||
    config.playbackControlMode !== 'easyjam' ||
    !config.autoStartPlayback ||
    partyState.sync.manualPause ||
    partyState.sync.playbackControlSuspended ||
    !current?.isPlaying ||
    !current.track?.durationMs
  ) {
    return;
  }
  const currentUri = current.track.uri;
  if (!nextManagedTrack(currentUri)) return;
  if (optimisticTrackAdvanceForUri === currentUri) return;

  const elapsedSinceSnapshotMs = Math.max(
    Date.now() - playbackSnapshot.fetchedAt,
    0
  );
  const estimatedProgressMs = Math.min(
    Number(current.progressMs ?? 0) + elapsedSinceSnapshotMs,
    current.track.durationMs
  );
  const remainingMs = Math.max(current.track.durationMs - estimatedProgressMs, 0);
  const handoffDelayMs = Math.max(remainingMs - config.handoffLeadMs, 0);
  optimisticTrackAdvanceForUri = currentUri;
  optimisticTrackAdvanceTimer = setTimeout(() => {
    optimisticTrackAdvanceTimer = null;
    optimisticTrackAdvanceForUri = null;
    if (
      playbackSnapshot.current?.isPlaying &&
      playbackSnapshot.current.track?.uri === currentUri
    ) {
      void advanceEasyJamPlayback(currentUri);
    }
  }, handoffDelayMs);
  optimisticTrackAdvanceTimer.unref?.();
}

async function advanceEasyJamPlayback(currentUri) {
  const current = playbackSnapshot.current;
  if (
    !config.easyJamEnabled ||
    config.playbackControlMode !== 'easyjam' ||
    partyState.sync.manualPause ||
    partyState.sync.playbackControlSuspended ||
    !current?.isPlaying ||
    current.track?.uri !== currentUri
  ) {
    return;
  }

  // Resolve the next URI only when the handoff executes: request and fallback
  // changes made while the current song is playing are honoured without
  // trusting Spotify Desktop to refresh its active playlist context.
  const nextTrack = nextManagedTrack(currentUri);
  if (!nextTrack) return;

  try {
    await startPlaylistPlayback(nextTrack.uri, 'scheduled_handoff');
    beginOptimisticCompletion(currentUri, nextTrack.uri);
    scheduleFallbackTailRefresh(nextTrack.uri);
  } catch (error) {
    partyState.sync.lastError = {
      message: error.message,
      status: error.status ?? 500,
      details: error.details ?? null
    };
    if (error.status === 429 && playbackSnapshot.current?.track?.uri === currentUri) {
      const retryAfterMs = Math.max(Number(error.retryAfterSeconds) * 1000 || 0, MIN_HANDOFF_RETRY_MS);
      optimisticTrackAdvanceForUri = currentUri;
      optimisticTrackAdvanceTimer = setTimeout(() => {
        optimisticTrackAdvanceTimer = null;
        optimisticTrackAdvanceForUri = null;
        void advanceEasyJamPlayback(currentUri);
      }, retryAfterMs);
      optimisticTrackAdvanceTimer.unref?.();
    }
  }
}

function scheduleFallbackTailRefresh(currentUri) {
  if (partyState.sync.lastPlaylistUris.at(-1) !== currentUri) return;
  scheduleSpotifySync({
    ensureFallbackTail: true,
    currentTrackUri,
    suppressPlaybackStart: true
  });
}

export function getCachedCurrentPlayback() {
  return {
    current: playbackSnapshot.current,
    fetchedAt: playbackSnapshot.fetchedAt,
    optimistic: playbackSnapshot.optimistic
  };
}

function recordSpotifyRequest({
  method = 'GET',
  path,
  status,
  durationMs,
  outcome,
  retryAfterSeconds = null,
  reason = 'unknown',
  diagnostic = null
}) {
  const safeDiagnostic = diagnostic && typeof diagnostic === 'object'
    ? {
        ...(typeof diagnostic.origin === 'string' ? { origin: diagnostic.origin } : {}),
        ...(typeof diagnostic.targetTrackUri === 'string' ? { targetTrackUri: diagnostic.targetTrackUri } : {}),
        ...(Number.isFinite(diagnostic.trackCount) ? { trackCount: diagnostic.trackCount } : {}),
        ...(typeof diagnostic.firstTrackUri === 'string' ? { firstTrackUri: diagnostic.firstTrackUri } : {}),
        ...(typeof diagnostic.lastTrackUri === 'string' ? { lastTrackUri: diagnostic.lastTrackUri } : {}),
        ...(typeof diagnostic.chunk === 'string' ? { chunk: diagnostic.chunk } : {}),
        ...(Number.isFinite(diagnostic.observedTrackCount)
          ? { observedTrackCount: diagnostic.observedTrackCount }
          : {}),
        ...(typeof diagnostic.observedFirstTrackUri === 'string'
          ? { observedFirstTrackUri: diagnostic.observedFirstTrackUri }
          : {}),
        ...(typeof diagnostic.observedLastTrackUri === 'string'
          ? { observedLastTrackUri: diagnostic.observedLastTrackUri }
          : {}),
        ...(typeof diagnostic.verified === 'boolean' ? { verified: diagnostic.verified } : {}),
        ...(sanitizeDiagnosticUris(diagnostic.playlistUris)
          ? { playlistUris: sanitizeDiagnosticUris(diagnostic.playlistUris) }
          : {}),
        ...(sanitizeDiagnosticUris(diagnostic.observedPlaylistUris)
          ? { observedPlaylistUris: sanitizeDiagnosticUris(diagnostic.observedPlaylistUris) }
          : {})
      }
    : null;
  spotifyRequestLog.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    method,
    path,
    status: status ?? null,
    durationMs: Math.max(0, Math.round(durationMs ?? 0)),
    outcome,
    retryAfterSeconds,
    reason,
    diagnostic: safeDiagnostic
  });
  if (spotifyRequestLog.length > SPOTIFY_REQUEST_LOG_LIMIT) spotifyRequestLog.length = SPOTIFY_REQUEST_LOG_LIMIT;
}

export function getSpotifyRequestLog() {
  return {
    requests: spotifyRequestLog,
    maxEntries: SPOTIFY_REQUEST_LOG_LIMIT,
    rateLimitedUntil: spotifyRateLimitedUntil || null
  };
}

export function clearSpotifyRequestLog() {
  spotifyRequestLog.length = 0;
}

export function exportSpotifyRequestLogText() {
  const lines = [
    'EasyJAM Spotify API diagnostics',
    `Exported: ${new Date().toISOString()}`,
    `Entries: ${spotifyRequestLog.length}`,
    ''
  ];

  for (const entry of [...spotifyRequestLog].reverse()) {
    lines.push(`${entry.at}\t${entry.method} ${entry.path}\t${entry.reason}\tHTTP ${entry.status ?? '—'}\t${entry.outcome}\t${entry.durationMs} ms`);
    const diagnostic = entry.diagnostic;
    if (!diagnostic) continue;
    if (diagnostic.playlistUris?.length) {
      lines.push(`Expected playlist URIs (${diagnostic.playlistUris.length} logged):`);
      diagnostic.playlistUris.forEach((uri, index) => lines.push(`  ${index + 1}. ${uri}`));
    }
    if (diagnostic.observedPlaylistUris?.length) {
      lines.push(`Observed Spotify URIs (${diagnostic.observedPlaylistUris.length} logged):`);
      diagnostic.observedPlaylistUris.forEach((uri, index) => lines.push(`  ${index + 1}. ${uri}`));
    }
    if (diagnostic.verified !== undefined) lines.push(`Verification: ${diagnostic.verified ? 'match' : 'mismatch'}`);
    lines.push('');
  }

  return lines.join('\n');
}

function getRateLimitBackoffMs() {
  const exponentialMs = Math.min(
    DEFAULT_RATE_LIMIT_BACKOFF_MS * 2 ** Math.max(spotifyRateLimitStrikes - 1, 0),
    MAX_RATE_LIMIT_BACKOFF_MS
  );
  const jitterMs = Math.round(Math.random() * exponentialMs * RATE_LIMIT_JITTER_RATIO);
  return Math.min(exponentialMs + jitterMs, MAX_RATE_LIMIT_BACKOFF_MS);
}

export async function refreshPinnedPlaylists() {
  if (!partyState.host.tokens?.accessToken || !partyState.pinnedPlaylists.length) {
    return { skipped: true, changed: false };
  }

  const snapshots = await Promise.allSettled(
    partyState.pinnedPlaylists.map((playlist) =>
      spotifyApi(
        `/playlists/${playlist.id}?fields=id,name,owner(display_name,id),images,url,external_urls(spotify),items(total)`,
        { reason: 'pinned_metadata_refresh' }
      )
    )
  );
  let changed = false;

  partyState.pinnedPlaylists = partyState.pinnedPlaylists.map((playlist, index) => {
    const snapshot = snapshots[index];
    if (snapshot.status !== 'fulfilled') return playlist;

    const fresh = snapshot.value;
    const next = {
      ...playlist,
      name: fresh.name ?? playlist.name,
      owner: fresh.owner?.display_name ?? fresh.owner?.id ?? playlist.owner,
      image: fresh.images?.[0]?.url ?? null,
      url: fresh.external_urls?.spotify ?? playlist.url,
      trackTotal: Math.max(Number(fresh.items?.total) || 0, 0)
    };
    if (
      next.name !== playlist.name ||
      next.owner !== playlist.owner ||
      next.image !== playlist.image ||
      next.url !== playlist.url ||
      next.trackTotal !== playlist.trackTotal
    ) {
      changed = true;
    }
    return next;
  });

  if (changed) fallbackPageCache.clear();
  return { skipped: false, changed };
}

export class SpotifyError extends Error {
  constructor(message, status = 500, details = null, retryAfterSeconds = null) {
    super(message);
    this.name = 'SpotifyError';
    this.status = status;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function requireSpotifyConfig() {
  if (!config.spotifyClientId || !config.spotifyClientSecret) {
    throw new SpotifyError(
      'Spotify OAuth credentials are missing. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.',
      500
    );
  }
}

function tokenAuthHeader() {
  const credentials = Buffer.from(
    `${config.spotifyClientId}:${config.spotifyClientSecret}`
  ).toString('base64');
  return `Basic ${credentials}`;
}

function normalizeTokens(tokenResponse) {
  return {
    accessToken: tokenResponse.access_token,
    refreshToken:
      tokenResponse.refresh_token ?? partyState.host.tokens?.refreshToken ?? null,
    scope: tokenResponse.scope,
    tokenType: tokenResponse.token_type,
    expiresAt: Date.now() + Number(tokenResponse.expires_in ?? 3600) * 1000
  };
}

async function readSpotifyResponse(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestToken(body) {
  requireSpotifyConfig();
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${ACCOUNTS_BASE}/api/token`, {
      method: 'POST',
      headers: {
        Authorization: tokenAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(body)
    });
  } catch (error) {
    recordSpotifyRequest({
      method: 'POST', path: 'accounts/api/token', durationMs: Date.now() - startedAt, outcome: 'network_error', reason: 'authentication'
    });
    throw error;
  }
  const payload = await readSpotifyResponse(response);
  recordSpotifyRequest({
    method: 'POST',
    path: 'accounts/api/token',
    status: response.status,
    durationMs: Date.now() - startedAt,
    outcome: response.ok ? 'success' : 'error',
    reason: 'authentication'
  });

  if (!response.ok) {
    throw new SpotifyError(
      payload?.error_description ?? payload?.error ?? 'Spotify token request failed',
      response.status,
      payload
    );
  }

  return normalizeTokens(payload);
}

export function createAuthorizationUrl() {
  requireSpotifyConfig();
  const state = crypto.randomBytes(16).toString('hex');
  partyState.host.oauthState = state;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.spotifyClientId,
    scope: spotifyScopes.join(' '),
    redirect_uri: config.spotifyRedirectUri,
    state
  });

  return `${ACCOUNTS_BASE}/authorize?${params.toString()}`;
}

export async function exchangeCodeForTokens(code) {
  const tokens = await requestToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.spotifyRedirectUri
  });
  setHostTokens(tokens);
  return tokens;
}

export async function refreshAccessToken() {
  const refreshToken = partyState.host.tokens?.refreshToken;
  if (!refreshToken) {
    throw new SpotifyError('Spotify refresh token is missing', 401);
  }

  const tokens = await requestToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  setHostTokens(tokens);
  return tokens;
}

export async function ensureAccessToken() {
  const tokens = partyState.host.tokens;
  if (!tokens?.accessToken) {
    throw new SpotifyError('Host has not connected Spotify', 401);
  }

  if (tokens.expiresAt - Date.now() < 60_000) {
    return refreshAccessToken();
  }

  return tokens.accessToken;
}

export async function spotifyApi(path, options = {}) {
  const {
    reason = 'unknown',
    diagnostic = null,
    diagnosticFromResponse = null,
    ...requestOptions
  } = options;
  const method = requestOptions.method ?? 'GET';
  const now = Date.now();
  if (spotifyRateLimitedUntil > now) {
    const retryAfterSeconds = Math.ceil((spotifyRateLimitedUntil - now) / 1000);
    recordSpotifyRequest({ method, path, status: 429, outcome: 'cooldown', retryAfterSeconds, reason, diagnostic });
    throw new SpotifyError(
      'Spotify rate limit is active. Try again shortly.',
      429,
      { method, path },
      retryAfterSeconds
    );
  }

  const accessToken = await ensureAccessToken();
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...requestOptions,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(requestOptions.headers ?? {})
      },
      body:
        requestOptions.body && typeof requestOptions.body !== 'string'
          ? JSON.stringify(requestOptions.body)
          : requestOptions.body
    });
  } catch (error) {
    recordSpotifyRequest({ method, path, durationMs: Date.now() - startedAt, outcome: 'network_error', reason, diagnostic });
    throw error;
  }

  if (response.status === 204) {
    if (spotifyRateLimitedUntil <= Date.now()) spotifyRateLimitStrikes = 0;
    recordSpotifyRequest({ method, path, status: response.status, durationMs: Date.now() - startedAt, outcome: 'success', reason, diagnostic });
    return null;
  }

  const payload = await readSpotifyResponse(response);

  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    let retryAfterSeconds = Number(retryAfter) > 0 ? Number(retryAfter) : null;
    if (response.status === 429) {
      spotifyRateLimitStrikes += 1;
      const backoffMs = getRateLimitBackoffMs();
      retryAfterSeconds = Math.max(
        retryAfterSeconds ?? 0,
        Math.ceil(backoffMs / 1000)
      );
      spotifyRateLimitedUntil = Math.max(
        spotifyRateLimitedUntil,
        Date.now() + retryAfterSeconds * 1000
      );
    }
    recordSpotifyRequest({
      method,
      path,
      status: response.status,
      durationMs: Date.now() - startedAt,
      outcome: response.status === 429 ? 'rate_limited' : 'error',
      retryAfterSeconds,
      reason,
      diagnostic
    });
    throw new SpotifyError(
      payload?.error?.message ?? payload?.error_description ?? 'Spotify API request failed',
      response.status,
      {
        spotify: payload,
        method,
        path
      },
      retryAfterSeconds
    );
  }

  const responseDiagnostic =
    typeof diagnosticFromResponse === 'function'
      ? { ...(diagnostic ?? {}), ...diagnosticFromResponse(payload) }
      : diagnostic;
  if (spotifyRateLimitedUntil <= Date.now()) spotifyRateLimitStrikes = 0;
  recordSpotifyRequest({
    method,
    path,
    status: response.status,
    durationMs: Date.now() - startedAt,
    outcome: 'success',
    reason,
    diagnostic: responseDiagnostic
  });
  return payload;
}

async function getCachedPlaylistItems(path, cacheMs, { force = false, reason = 'playlist_browsing' } = {}) {
  const now = Date.now();
  const cached = playlistItemsCache.get(path);
  if (!force && cached && cached.expiresAt > now) return cached.promise;

  const promise = spotifyApi(path, { reason }).catch((error) => {
    playlistItemsCache.delete(path);
    throw error;
  });
  playlistItemsCache.set(path, { expiresAt: now + cacheMs, promise });
  return promise;
}

function sameUriSequence(left, right) {
  return left.length === right.length && left.every((uri, index) => uri === right[index]);
}

async function getFallbackPage(playlist) {
  const now = Date.now();
  const cached = fallbackPageCache.get(playlist.id);
  if (cached && cached.expiresAt > now) return cached.tracks;

  const pageLimit = Math.min(RANDOM_FALLBACK_PAGE_SIZE, playlist.total);
  const maxOffset = Math.max(playlist.total - pageLimit, 0);
  const offset = maxOffset ? Math.floor(Math.random() * (maxOffset + 1)) : 0;
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(pageLimit),
    fields:
      'items(item(id,name,uri,duration_ms,explicit,artists(name),album(name,images)))'
  });
  const result = await getCachedPlaylistItems(
    `/playlists/${playlist.id}/items?${params.toString()}`,
    RANDOM_FALLBACK_PAGE_CACHE_MS,
    { reason: 'fallback_selection' }
  );
  const tracks = shuffle(
    result.items
      ?.map((playlistItem) => normalizeSpotifyTrack(playlistItem.item))
      .filter((track) => track?.uri?.startsWith('spotify:track:')) ?? []
  );
  fallbackPageCache.set(playlist.id, {
    expiresAt: now + RANDOM_FALLBACK_PAGE_CACHE_MS,
    tracks
  });
  return tracks;
}

export function normalizeSpotifyTrack(track, item = null) {
  if (!track) return null;
  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: track.artists?.map((artist) => artist.name) ?? [],
    album: track.album?.name ?? '',
    image: track.album?.images?.[0]?.url ?? track.album?.images?.[1]?.url ?? null,
    durationMs: track.duration_ms ?? 0,
    addedAt: item?.added_at ?? null,
    explicit: Boolean(track.explicit)
  };
}

export async function bootstrapHostPlaylist() {
  const me = await spotifyApi('/me', { reason: 'host_setup' });
  setHostUser(me);

  if (partyState.host.playlistId) {
    const playlist = await spotifyApi(`/playlists/${partyState.host.playlistId}`, { reason: 'host_setup' });
    setHostPlaylist(playlist);
    return playlist;
  }

  const playlist = await spotifyApi(`/users/${me.id}/playlists`, {
    method: 'POST',
    body: {
      name: 'EasyJAM Party Queue',
      public: false,
      collaborative: false,
      description: 'Dynamically managed party queue generated by EasyJAM.'
    },
    reason: 'host_setup'
  });
  setHostPlaylist(playlist);
  return playlist;
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function clearPendingHandoffTimer() {
  if (pendingHandoffTimer) {
    clearTimeout(pendingHandoffTimer);
    pendingHandoffTimer = null;
  }
}

function clearScheduledSyncTimer() {
  if (scheduledSyncTimer) {
    clearTimeout(scheduledSyncTimer);
    scheduledSyncTimer = null;
  }
}

function mergeScheduledSyncOptions(current = {}, next = {}) {
  return {
    restartIfPaused: Boolean(current.restartIfPaused || next.restartIfPaused),
    deferToCurrentTrack: Boolean(current.deferToCurrentTrack || next.deferToCurrentTrack),
    preserveCurrentTrack: Boolean(current.preserveCurrentTrack || next.preserveCurrentTrack),
    preserveExternalPlayback: Boolean(
      current.preserveExternalPlayback || next.preserveExternalPlayback
    ),
    ensureFallbackTail: Boolean(current.ensureFallbackTail || next.ensureFallbackTail),
    currentTrackUri: next.currentTrackUri ?? current.currentTrackUri ?? null,
    suppressPlaybackStart: Boolean(current.suppressPlaybackStart || next.suppressPlaybackStart)
  };
}

function recordScheduledSyncError(error) {
  partyState.sync.lastError = {
    message: error.message,
    status: error.status ?? 500,
    details: error.details ?? null
  };
}

function scheduleQueuedSync(delayMs) {
  clearScheduledSyncTimer();
  const dueAt = Date.now() + delayMs;
  partyState.sync.syncPending = true;
  partyState.sync.scheduledSyncAt = new Date(dueAt).toISOString();
  scheduledSyncTimer = setTimeout(() => {
    scheduledSyncTimer = null;
    void runScheduledSpotifySync();
  }, delayMs);
  scheduledSyncTimer.unref?.();
}

async function runScheduledSpotifySync() {
  if (!scheduledSyncOptions) return;
  if (partyState.sync.inFlight) {
    scheduleQueuedSync(AUTOMATIC_SYNC_DEBOUNCE_MS);
    return;
  }

  const options = scheduledSyncOptions;
  scheduledSyncOptions = null;
  partyState.sync.syncPending = false;
  partyState.sync.scheduledSyncAt = null;
  lastAutomaticSyncAt = Date.now();

  try {
    await syncSpotifyPlaylist(options);
  } catch (error) {
    recordScheduledSyncError(error);
    if (error.status === 429) {
      scheduledSyncOptions = mergeScheduledSyncOptions(scheduledSyncOptions ?? {}, options);
      const retryAfterMs = Math.max(
        Number(error.retryAfterSeconds) * 1000 || 0,
        AUTOMATIC_SYNC_MIN_INTERVAL_MS
      );
      scheduleQueuedSync(retryAfterMs);
    }
  }

  if (scheduledSyncOptions && !scheduledSyncTimer) {
    const waitMs = Math.max(
      AUTOMATIC_SYNC_DEBOUNCE_MS,
      lastAutomaticSyncAt + AUTOMATIC_SYNC_MIN_INTERVAL_MS - Date.now()
    );
    scheduleQueuedSync(waitMs);
  }
}

export function scheduleSpotifySync(options = {}) {
  if (!config.easyJamEnabled) {
    return { scheduled: false, disabled: true, dueAt: null };
  }
  scheduledSyncOptions = mergeScheduledSyncOptions(scheduledSyncOptions ?? {}, options);
  const waitMs = Math.max(
    AUTOMATIC_SYNC_DEBOUNCE_MS,
    lastAutomaticSyncAt + AUTOMATIC_SYNC_MIN_INTERVAL_MS - Date.now()
  );
  scheduleQueuedSync(waitMs);
  return {
    scheduled: true,
    dueAt: partyState.sync.scheduledSyncAt
  };
}

export function cancelScheduledSpotifySync() {
  clearScheduledSyncTimer();
  scheduledSyncOptions = null;
  partyState.sync.syncPending = false;
  partyState.sync.scheduledSyncAt = null;
}

export function cancelEasyJamPlaybackHandoff() {
  clearOptimisticTrackAdvanceTimer();
}

function recordPendingHandoffError(error) {
  partyState.sync.lastError = {
    message: error.message,
    status: error.status ?? 500,
    details: error.details ?? null
  };
}

function runPendingHandoff() {
  pendingHandoffTimer = null;
  void executePendingHandoff().catch((error) => {
    recordPendingHandoffError(error);
    if (error.status !== 429 || !partyState.sync.pendingHandoff?.nextUri) return;

    const retryAfterMs = Math.max(
      Number(error.retryAfterSeconds) * 1000 || 0,
      MIN_HANDOFF_RETRY_MS
    );
    pendingHandoffTimer = setTimeout(runPendingHandoff, retryAfterMs);
    pendingHandoffTimer.unref?.();
  });
}

function schedulePendingHandoff(playback) {
  const pendingHandoff = partyState.sync.pendingHandoff;
  if (!pendingHandoff?.nextUri || !playback?.track?.durationMs) return;

  clearPendingHandoffTimer();
  const remainingMs = Math.max(
    Number(playback.track.durationMs) - Number(playback.progressMs ?? 0),
    0
  );
  pendingHandoffTimer = setTimeout(
    runPendingHandoff,
    Math.max(remainingMs - config.handoffLeadMs, 0)
  );
  pendingHandoffTimer.unref?.();
}

  async function executePendingHandoff() {
  const pendingHandoff = partyState.sync.pendingHandoff;
  if (
    !config.easyJamEnabled ||
    !config.autoStartPlayback ||
    partyState.sync.manualPause ||
    partyState.sync.playbackControlSuspended ||
    partyState.sync.protectedPlaybackUri ||
    !pendingHandoff?.nextUri ||
    partyState.sync.inFlight
  ) {
    return;
  }

  // This runs at the configured handoff lead, so it must not make a decision
  // from the normal shared playback snapshot.
  const playback = await getCurrentPlayback({
    force: config.playbackControlMode !== 'easyjam',
    reason: 'handoff_check'
  });
  if (!playback?.isPlaying) {
    pauseAutomaticPlayback();
    return;
  }
  if (playback?.isPlaying && playback.track?.uri === pendingHandoff.currentUri) {
    const remainingMs = Math.max(
      Number(playback.track.durationMs ?? 0) - Number(playback.progressMs ?? 0),
      0
    );
    if (remainingMs > config.handoffLeadMs + HANDOFF_RESCHEDULE_TOLERANCE_MS) {
      schedulePendingHandoff(playback);
      return;
    }
  }

  if (playback?.isPlaying && playback.track?.uri === pendingHandoff.nextUri) {
    partyState.sync.pendingHandoff = null;
    clearPendingHandoffTimer();
    return;
  }

  const easyJamContextUri = partyState.host.playlistId
    ? `spotify:playlist:${partyState.host.playlistId}`
    : null;
  const playbackIsManaged =
    playback.contextUri === easyJamContextUri &&
    partyState.sync.lastPlaylistUris.includes(playback.track?.uri);
  if (playbackIsManaged && playback.track?.uri !== pendingHandoff.currentUri) {
    // Spotify has already progressed within the managed playlist, but not to
    // this timer's target. The timer is stale; never rewind playback to it.
    partyState.sync.pendingHandoff = null;
    clearPendingHandoffTimer();
    return;
  }

  await syncSpotifyPlaylist({
    forceRestart: true,
    startAtUri: pendingHandoff.nextUri,
    playbackStartOrigin: 'scheduled_handoff'
  });
}

function pauseAutomaticPlayback() {
  partyState.sync.manualPause = true;
  partyState.sync.returnToEasyJamPending = false;
  partyState.sync.pendingHandoff = null;
  partyState.sync.protectedPlaybackUri = null;
  partyState.sync.noActivePlaybackSince = null;
  clearPendingHandoffTimer();
}

function resumeAutomaticPlayback() {
  partyState.sync.manualPause = false;
}

export function protectCurrentPlayback(currentPlayback) {
  const trackUri = currentPlayback?.isPlaying ? currentPlayback.track?.uri : null;
  if (!trackUri) return false;

  partyState.sync.protectedPlaybackUri = trackUri;
  partyState.sync.noActivePlaybackSince = null;
  partyState.sync.pendingHandoff = null;
  clearPendingHandoffTimer();
  return true;
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

async function getRandomFallbackTracks(
  limit = RANDOM_FALLBACK_TRACK_COUNT,
  excludedUris = new Set()
) {
  const playlists = partyState.pinnedPlaylists.filter(
    (playlist) => playlist.id && playlist.fallbackEnabled !== false
  );
  if (!playlists.length) return [];

  const playlistTotals = await Promise.all(
    playlists.map(async (playlist) => {
      const persistedTotal = Number(playlist.trackTotal);
      if (Number.isFinite(persistedTotal) && persistedTotal >= 0) {
        return { id: playlist.id, total: persistedTotal };
      }
      const params = new URLSearchParams({
        limit: '1',
        fields: 'total'
      });
      const result = await getCachedPlaylistItems(
        `/playlists/${playlist.id}/items?${params.toString()}`,
        PLAYLIST_ITEMS_CACHE_MS
      );
      return {
        id: playlist.id,
        total: Math.max(Number(result?.total) || 0, 0)
      };
    })
  );

  const availablePlaylists = playlistTotals.filter((playlist) => playlist.total > 0);
  const tracks = [];
  const addedUris = new Set(excludedUris);
  let attempts = 0;

  while (tracks.length < limit && attempts < availablePlaylists.length * 4) {
    attempts += 1;
    const playlist =
      availablePlaylists[Math.floor(Math.random() * availablePlaylists.length)];
    const pageTracks = await getFallbackPage(playlist);

    for (const track of pageTracks) {
      if (tracks.length >= limit) break;
      if (addedUris.has(track.uri)) continue;
      addedUris.add(track.uri);
      tracks.push(track);
    }
  }

  return tracks;
}

async function getFallbackTracksWithRepeats(
  limit,
  excludedUris = new Set(),
  { allowRepeats = true } = {}
) {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentUris = new Set(
    partyState.playback.history
      .filter((item) => Date.parse(item.addedAt) >= oneHourAgo)
      .map((item) => item.track?.uri)
      .filter(Boolean)
  );
  const tracks = await getRandomFallbackTracks(
    limit,
    new Set([...excludedUris, ...recentUris])
  );
  if (tracks.length >= limit) return tracks;

  const fallbackTracks = await getRandomFallbackTracks(
    limit - tracks.length,
    excludedUris
  );
  const combined = [...tracks, ...fallbackTracks];
  if (combined.length >= limit || !allowRepeats) return combined;

  const repeatedTracks = await getRandomFallbackTracks(limit - combined.length);
  return [...combined, ...repeatedTracks];
}

export async function syncSpotifyPlaylist(
  {
    forceRestart = false,
    ensureFallbackTail = false,
    restartIfPaused = false,
    deferToCurrentTrack = false,
    preserveCurrentTrack = false,
    preserveExternalPlayback = false,
    suppressPlaybackStart = false,
    verifyPlaylist = false,
    startAtUri = null,
    currentTrackUri = null,
    playbackStartOrigin = 'playlist_sync',
    forcePlaylistReplace = false,
    preserveExpectedTrackUri = null,
    manualHostPlaylistSync = false
  } = {}
) {
  if (!config.easyJamEnabled) {
    return { skipped: true, reason: 'EasyJAM is disabled' };
  }
  if (!partyState.host.tokens?.accessToken || !partyState.host.playlistId) {
    return { skipped: true, reason: 'Host Spotify connection is not ready' };
  }

  if (
    partyState.host.playlistOwnerId &&
    partyState.host.user?.id &&
    partyState.host.playlistOwnerId !== partyState.host.user.id
  ) {
    throw new SpotifyError('Host playlist is owned by a different Spotify user', 403, {
      hostUserId: partyState.host.user.id,
      playlistOwnerId: partyState.host.playlistOwnerId,
      playlistOwnerName: partyState.host.playlistOwnerName,
      playlistId: partyState.host.playlistId
    });
  }

  const queueItems = getCombinedQueue();
  let currentPlaybackForSync = null;
  if (deferToCurrentTrack || preserveCurrentTrack) {
    currentPlaybackForSync = await getCurrentPlayback({ reason: 'playlist_sync_playback_check' });
  }
  const easyJamContextUri = `spotify:playlist:${partyState.host.playlistId}`;
  const queueUris = queueItems.map((item) => item.track.uri);
  const currentPlaybackUri =
    preserveExpectedTrackUri ?? currentPlaybackForSync?.track?.uri ?? null;
  const currentUriIsManaged = partyState.sync.lastPlaylistUris.includes(currentPlaybackUri);
  const currentPlaybackIsManaged = isPlaybackManagedByEasyJam(currentPlaybackForSync);
  const currentIsEasyJamFallback =
    (preserveExpectedTrackUri || currentPlaybackIsManaged) &&
    currentPlaybackUri &&
    currentUriIsManaged &&
    !queueUris.includes(currentPlaybackUri);
  const currentIsExternalTrack =
    currentPlaybackForSync?.isPlaying &&
    !currentPlaybackIsManaged;
  const preserveCurrentExternal = Boolean(
    preserveExternalPlayback && currentIsExternalTrack
  );
  const currentFallbackUri = currentIsEasyJamFallback ? currentPlaybackUri : null;
  const preserveCurrentFallback = Boolean(
    (preserveCurrentTrack || preserveExpectedTrackUri) && currentFallbackUri
  );
  const fallbackLimit = partyState.randomFallback.enabled
    ? RANDOM_FALLBACK_TRACK_COUNT
    : 1;
  const shouldAppendFallbackTail =
    ensureFallbackTail &&
    partyState.sync.lastPlaylistUris.length;
  const orderedQueueUris = currentFallbackUri
    ? [currentFallbackUri, ...queueUris.filter((uri) => uri !== currentFallbackUri)]
    : queueUris;
  const excludedFallbackUris = new Set([
    ...orderedQueueUris,
    ...(currentPlaybackUri ? [currentPlaybackUri] : [])
  ]);
  const fallbackTrackLimit = queueItems.length
    ? FALLBACK_SAFETY_TRACK_COUNT
    : preserveCurrentFallback
      ? 1
      : fallbackLimit;
  const fallbackTracks = shouldAppendFallbackTail
    ? []
    : await getFallbackTracksWithRepeats(
      fallbackTrackLimit,
      excludedFallbackUris,
      { allowRepeats: !currentPlaybackUri }
    );
  let nextFallbackTracks = fallbackTracks;
  let uris = queueItems.length
    ? [...orderedQueueUris, ...fallbackTracks.map((track) => track.uri)]
    : preserveCurrentFallback
      ? [currentFallbackUri, ...fallbackTracks.map((track) => track.uri)]
      : fallbackTracks.map((track) => track.uri);
  if (
    shouldAppendFallbackTail
  ) {
    const retainedUris = currentTrackUri
      ? [currentTrackUri]
      : partyState.sync.lastPlaylistUris.slice(-1);
    const nextFallback = await getFallbackTracksWithRepeats(
      1,
      new Set(retainedUris)
    );
    const nextUri = nextFallback[0]?.uri;
    if (nextUri) {
      uris = [...retainedUris, nextUri];
      nextFallbackTracks = nextFallback;
    } else {
      uris = retainedUris;
    }
  }
  // Resolve the handoff from the final playlist, not just guest requests. This
  // lets an externally playing song transition directly into a fallback track
  // when the guest queue is empty.
  const handoffNextUri = uris.find((uri) => uri !== currentPlaybackUri) ?? null;
  const deferSourceRestart =
    !preserveExpectedTrackUri &&
    (preserveCurrentFallback || preserveCurrentExternal ||
    Boolean(
      currentPlaybackForSync?.isPlaying &&
      currentPlaybackUri &&
      handoffNextUri &&
      (currentFallbackUri || currentIsExternalTrack || currentPlaybackForSync.contextUri === easyJamContextUri)
    ));
  const nextPendingHandoff = deferSourceRestart
    ? {
        currentUri: currentPlaybackUri,
        nextUri: handoffNextUri
      }
    : null;
  const uriChunks = chunks(uris, 100);
  const shouldWriteHostPlaylist =
    config.playbackControlMode !== 'easyjam' || manualHostPlaylistSync;
  const playlistDiagnostic = {
    trackCount: uris.length,
    firstTrackUri: uris[0] ?? null,
    lastTrackUri: uris.at(-1) ?? null,
    playlistUris: uris
  };
  // `lastPlaylistUris` is deliberately in-memory.  After a server restart it
  // is empty, which must not be treated as proof that Spotify's remote
  // playlist is empty too.  The first sync therefore replaces the remote
  // playlist authoritatively, including when the desired result is empty.
  const playlistUnchanged =
    !shouldWriteHostPlaylist ||
    (!forcePlaylistReplace &&
    Boolean(partyState.sync.lastPlaylistSnapshotId) &&
    sameUriSequence(uris, partyState.sync.lastPlaylistUris));
  let source = shouldAppendFallbackTail
    ? partyState.sync.lastSource ?? 'randomFallback'
    : queueItems.length
      ? 'queue'
      : fallbackTracks.length || preserveCurrentFallback
        ? 'randomFallback'
        : 'empty';

  const mayAutoStartForSourceChange =
    config.autoStartPlayback &&
    !partyState.sync.manualPause &&
    !partyState.sync.playbackControlSuspended &&
    (uris.length || source === 'preserved') &&
    (!partyState.sync.autoStarted || partyState.sync.lastSource !== source);
  if (mayAutoStartForSourceChange && !currentPlaybackForSync) {
    currentPlaybackForSync = await getCurrentPlayback({ reason: 'playlist_sync_playback_check' });
    if (currentPlaybackForSync && !currentPlaybackForSync.isPlaying) {
      pauseAutomaticPlayback();
    }
  }

  partyState.sync.inFlight = true;
  partyState.sync.lastError = null;

  try {
    let replaceResult = null;
    if (shouldWriteHostPlaylist && !playlistUnchanged) {
      replaceResult = await spotifyApi(`/playlists/${partyState.host.playlistId}/items`, {
        method: 'PUT',
        body: { uris: uriChunks[0] ?? [] },
        reason: 'playlist_sync',
        diagnostic: {
          ...playlistDiagnostic,
          chunk: uriChunks.length ? '1/' + uriChunks.length : 'clear'
        }
      });

      for (const chunk of uriChunks.slice(1)) {
        await spotifyApi(`/playlists/${partyState.host.playlistId}/items`, {
          method: 'POST',
          body: { uris: chunk },
          reason: 'playlist_sync',
          diagnostic: {
            ...playlistDiagnostic,
            chunk: `${uriChunks.indexOf(chunk) + 1}/${uriChunks.length}`
          }
        });
      }
      partyState.sync.lastPlaylistSnapshotId = replaceResult?.snapshot_id ?? null;
    }

    let verification = null;
    if (shouldWriteHostPlaylist && (replaceResult || verifyPlaylist)) {
      const verifyParams = new URLSearchParams({
        limit: String(Math.min(Math.max(uris.length, 1), 100)),
        fields: 'total,items(item(uri))'
      });
      verification = await spotifyApi(
        `/playlists/${partyState.host.playlistId}/items?${verifyParams.toString()}`,
        {
          reason: 'playlist_sync_verification',
          diagnostic: playlistDiagnostic,
          diagnosticFromResponse: (result) => {
            const observedUris = (result?.items ?? [])
              .map((entry) => entry?.item?.uri)
              .filter(Boolean);
            const totalMatches = Number(result?.total) === uris.length;
            const returnedPrefixMatches = sameUriSequence(
              observedUris,
              uris.slice(0, observedUris.length)
            );
            return {
              observedTrackCount: Number(result?.total) || 0,
              observedFirstTrackUri: observedUris[0] ?? null,
              observedLastTrackUri: observedUris.at(-1) ?? null,
              observedPlaylistUris: observedUris,
              verified: totalMatches && returnedPrefixMatches
            };
          }
        }
      );
      const observedUris = (verification.items ?? [])
        .map((entry) => entry?.item?.uri)
        .filter(Boolean);
      const totalMatches = Number(verification.total) === uris.length;
      const returnedPrefixMatches = sameUriSequence(
        observedUris,
        uris.slice(0, observedUris.length)
      );
      if (!totalMatches || !returnedPrefixMatches) {
        throw new SpotifyError('Spotify did not persist the expected host playlist items', 409, {
          expectedTrackCount: uris.length,
          expectedFirstTrackUri: uris[0] ?? null,
          expectedLastTrackUri: uris.at(-1) ?? null,
          observedTrackCount: Number(verification.total) || 0,
          observedFirstTrackUri: observedUris[0] ?? null,
          observedLastTrackUri: observedUris.at(-1) ?? null
        });
      }
    }
    partyState.sync.fallbackTracks = nextFallbackTracks;
    partyState.sync.lastPlaylistUris = [...uris];
    if (playbackSnapshot.optimistic) {
      scheduleOptimisticTrackAdvance(playbackSnapshot.current);
    }
    partyState.sync.pendingHandoff = nextPendingHandoff;
    if (!nextPendingHandoff) clearPendingHandoffTimer();

    let pausedOrOutsideEasyJam = false;
    let deferExternalPlayback = false;
    if (restartIfPaused && config.autoStartPlayback && !partyState.sync.manualPause) {
      const playback = await getCurrentPlayback({ reason: 'playlist_sync_playback_check' });
      if (playback && !playback.isPlaying) {
        pauseAutomaticPlayback();
      }
      const outsideEasyJam = playback && !isPlaybackManagedByEasyJam(playback);
      deferExternalPlayback = Boolean(outsideEasyJam && playback.isPlaying);
      pausedOrOutsideEasyJam =
        !partyState.sync.manualPause &&
        !deferExternalPlayback &&
        (!playback || !playback.isPlaying || outsideEasyJam);
      if (deferExternalPlayback) {
        partyState.sync.returnToEasyJamPending = true;
      }
    }

    const shouldRestartHostPlayback =
      config.autoStartPlayback &&
      !partyState.sync.manualPause &&
      !partyState.sync.playbackControlSuspended &&
      !suppressPlaybackStart &&
      (uris.length || source === 'preserved') &&
      !deferExternalPlayback &&
      !deferSourceRestart &&
      (
        forceRestart ||
        pausedOrOutsideEasyJam ||
        !partyState.sync.autoStarted ||
        partyState.sync.lastSource !== source
      );

    if (shouldRestartHostPlayback) {
      await startPlaylistPlayback(startAtUri, playbackStartOrigin);
      partyState.sync.autoStarted = true;
      partyState.sync.returnToEasyJamPending = false;
      partyState.sync.pendingHandoff = null;
      clearPendingHandoffTimer();
    }

    partyState.sync.lastSource = source;
    partyState.sync.playlistRefreshPending = false;

    if (partyState.sync.pendingHandoff?.currentUri === currentPlaybackUri) {
      schedulePendingHandoff(currentPlaybackForSync);
    }

    partyState.sync.lastSyncedAt = new Date().toISOString();
    return {
      skipped: false,
      count: uris.length,
      source,
      playlistId: partyState.host.playlistId,
      snapshotId: replaceResult?.snapshot_id ?? partyState.sync.lastPlaylistSnapshotId,
      verifiedTotal: verification?.total ?? null,
      firstUri: verification?.items?.[0]?.item?.uri ?? null,
      playlistUnchanged
    };
  } catch (error) {
    const details = {
      ...(error.details ?? {}),
      context: {
        hostUserId: partyState.host.user?.id ?? null,
        playlistId: partyState.host.playlistId,
        playlistOwnerId: partyState.host.playlistOwnerId,
        playlistOwnerName: partyState.host.playlistOwnerName,
        playlistPublic: partyState.host.playlistPublic,
        playlistCollaborative: partyState.host.playlistCollaborative,
        tokenScope: partyState.host.tokens?.scope ?? null,
        queuedUriCount: uris.length
      }
    };

    partyState.sync.lastError = {
      message: error.message,
      status: error.status ?? 500,
      details
    };
    error.details = details;
    throw error;
  } finally {
    partyState.sync.inFlight = false;
  }
}

export async function startPlaylistPlayback(startAtUri = null, origin = 'playlist_sync') {
  const targetTrackUri = startAtUri ?? partyState.sync.lastPlaylistUris[0] ?? null;
  if (config.playbackControlMode === 'easyjam') {
    return startDirectTrackPlayback(targetTrackUri, origin);
  }
  if (!partyState.host.playlistId) {
    throw new SpotifyError('Host playlist is not ready', 400);
  }

  const deviceId = partyState.host.playbackDevice?.id;
  const target = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  const result = await spotifyApi(`/me/player/play${target}`, {
    method: 'PUT',
    body: {
      context_uri: `spotify:playlist:${partyState.host.playlistId}`,
      ...(startAtUri ? { offset: { uri: startAtUri } } : {})
    },
    reason: 'easyjam_start',
    diagnostic: { origin, targetTrackUri }
  });
  const track = findKnownTrack(targetTrackUri);
  if (track) {
    setOptimisticPlayback({
      isPlaying: true,
      progressMs: 0,
      track,
      contextUri: `spotify:playlist:${partyState.host.playlistId}`,
      deviceId: partyState.host.playbackDevice?.id ?? null,
      deviceName: partyState.host.playbackDevice?.name ?? null
    });
  } else {
    invalidateCurrentPlaybackSnapshot();
  }
  return result;
}

async function startDirectTrackPlayback(trackUri, origin, positionMs = 0) {
  if (!trackUri) {
    throw new SpotifyError('EasyJAM has no track ready to play', 409);
  }

  const deviceId = partyState.host.playbackDevice?.id;
  const target = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  const result = await spotifyApi(`/me/player/play${target}`, {
    method: 'PUT',
    body: {
      uris: [trackUri],
      ...(positionMs > 0 ? { position_ms: positionMs } : {})
    },
    reason: 'easyjam_start',
    diagnostic: { origin, targetTrackUri: trackUri }
  });
  const track = findKnownTrack(trackUri);
  if (track) {
    setOptimisticPlayback({
      isPlaying: true,
      progressMs: positionMs,
      track,
      contextUri: null,
      easyJamManaged: true,
      deviceId: partyState.host.playbackDevice?.id ?? null,
      deviceName: partyState.host.playbackDevice?.name ?? null
    });
  } else {
    invalidateCurrentPlaybackSnapshot();
  }
  return result;
}

export async function getAvailableSpotifyDevices() {
  const result = await spotifyApi('/me/player/devices', { reason: 'playback_device_list' });
  return (result.devices ?? [])
    .filter((device) => device?.id && !device.is_restricted)
    .map((device) => ({
      id: device.id,
      name: device.name || 'Spotify Connect device',
      type: device.type || 'unknown',
      isActive: Boolean(device.is_active),
      volumePercent: Number.isFinite(device.volume_percent) ? device.volume_percent : null
    }));
}

export async function switchSpotifyPlaybackDevice(deviceId) {
  const devices = await getAvailableSpotifyDevices();
  const device = devices.find((candidate) => candidate.id === deviceId);
  if (!device) {
    throw new SpotifyError('Selected Spotify Connect device is no longer available', 409);
  }

  await spotifyApi('/me/player', {
    method: 'PUT',
    body: { device_ids: [device.id], play: false },
    reason: 'playback_device_switch'
  });
  partyState.host.playbackDevice = device;
  invalidateCurrentPlaybackSnapshot();
  return device;
}

export async function pauseSpotifyPlayback() {
  const deviceId = partyState.host.playbackDevice?.id;
  const target = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  const result = await spotifyApi(`/me/player/pause${target}`, { method: 'PUT', reason: 'playback_pause' });
  if (playbackSnapshot.current?.track) {
    setOptimisticPlayback({
      ...playbackSnapshot.current,
      isPlaying: false,
      easyJamManaged:
        playbackSnapshot.current.easyJamManaged ||
        (config.playbackControlMode === 'easyjam' &&
          partyState.sync.lastPlaylistUris.includes(playbackSnapshot.current.track.uri))
    });
  } else {
    invalidateCurrentPlaybackSnapshot();
  }
  return result;
}

export async function skipSpotifyTrack(direction = 'next') {
  const track = nextManagedTrack(playbackSnapshot.current?.track?.uri, direction);
  if (
    config.playbackControlMode === 'easyjam' &&
    playbackSnapshot.current?.track &&
    track
  ) {
    const previousUri = playbackSnapshot.current.track.uri;
    const result = await startPlaylistPlayback(track.uri, `admin_${direction}`);
    if (direction === 'next') beginOptimisticCompletion(previousUri, track.uri);
    scheduleFallbackTailRefresh(track.uri);
    return result;
  }

  const endpoint = direction === 'previous' ? '/me/player/previous' : '/me/player/next';
  const deviceId = partyState.host.playbackDevice?.id;
  const target = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
  const result = await spotifyApi(`${endpoint}${target}`, { method: 'POST', reason: 'playback_skip' });
  if (track && playbackSnapshot.current) {
    setOptimisticPlayback({ ...playbackSnapshot.current, isPlaying: true, progressMs: 0, track });
  } else {
    invalidateCurrentPlaybackSnapshot();
  }
  return result;
}

export async function seekSpotifyPlayback(positionMs) {
  const normalized = Math.max(0, Math.round(Number(positionMs)));
  if (!Number.isFinite(normalized)) {
    const error = new SpotifyError('Playback position must be a number', 400);
    throw error;
  }
  const deviceId = partyState.host.playbackDevice?.id;
  const target = deviceId ? `&device_id=${encodeURIComponent(deviceId)}` : '';
  const result = await spotifyApi(`/me/player/seek?position_ms=${normalized}${target}`, {
    method: 'PUT',
    reason: 'playback_seek'
  });
  if (playbackSnapshot.current?.track) {
    setOptimisticPlayback({ ...playbackSnapshot.current, progressMs: normalized });
  } else {
    invalidateCurrentPlaybackSnapshot();
  }
  return result;
}

export async function resumeEasyJamPlayback() {
  const easyJamContextUri = partyState.host.playlistId
    ? `spotify:playlist:${partyState.host.playlistId}`
    : null;
  const expectedPausedPlayback = playbackSnapshot.current?.track &&
    !playbackSnapshot.current.isPlaying &&
    (config.playbackControlMode === 'easyjam'
      ? playbackSnapshot.current.easyJamManaged
      : playbackSnapshot.current.contextUri === easyJamContextUri)
    ? {
        ...playbackSnapshot.current,
        track: { ...playbackSnapshot.current.track }
      }
    : null;
  const needsPreflight =
    !lastLivePlaybackReadAt ||
    Date.now() - lastLivePlaybackReadAt >= ADMIN_PLAY_PREFLIGHT_MAX_AGE_MS;

  if (needsPreflight) {
    // This is an infrequent recovery guard for a long pause, reconnect, or
    // external Spotify interference. The read is diagnostic only: EasyJAM
    // still restores its own saved track and position below.
    await getCurrentPlayback({ force: true, reason: 'admin_play_preflight_check' });
    await syncSpotifyPlaylist({
      forcePlaylistReplace: true,
      suppressPlaybackStart: true,
      preserveExpectedTrackUri: expectedPausedPlayback?.track?.uri ?? null
    });
  }

  resumeAutomaticPlayback();
  partyState.sync.returnToEasyJamPending = false;
  partyState.sync.pendingHandoff = null;
  partyState.sync.protectedPlaybackUri = null;
  partyState.sync.noActivePlaybackSince = null;
  clearPendingHandoffTimer();

  const pausedEasyJamTrack = expectedPausedPlayback;

  if (pausedEasyJamTrack) {
    const positionMs = Math.max(
      0,
      Math.min(
        Math.round(Number(pausedEasyJamTrack.progressMs) || 0),
        Math.max(Number(pausedEasyJamTrack.track.durationMs) - 1, 0)
      )
    );
    if (config.playbackControlMode === 'easyjam') {
      const result = await startDirectTrackPlayback(
        pausedEasyJamTrack.track.uri,
        'admin_restore',
        positionMs
      );
      partyState.sync.autoStarted = true;
      return result;
    }
    const deviceId = partyState.host.playbackDevice?.id;
    const target = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : '';
    const result = await spotifyApi(`/me/player/play${target}`, {
      method: 'PUT',
      body: {
        context_uri: easyJamContextUri,
        offset: { uri: pausedEasyJamTrack.track.uri },
        position_ms: positionMs
      },
      reason: 'easyjam_restore',
      diagnostic: {
        origin: 'admin_restore',
        targetTrackUri: pausedEasyJamTrack.track.uri
      }
    });
    setOptimisticPlayback({
      ...pausedEasyJamTrack,
      isPlaying: true,
      progressMs: positionMs
    });
    partyState.sync.autoStarted = true;
    return result;
  }

  const result = await startPlaylistPlayback(null, 'admin_start');
  partyState.sync.autoStarted = true;
  return result;
}

export function invalidateCurrentPlaybackSnapshot() {
  clearOptimisticTrackAdvanceTimer();
  playbackSnapshot.current = null;
  playbackSnapshot.fetchedAt = 0;
  playbackSnapshot.optimistic = false;
}

export async function getCurrentPlayback({ force = false, reason = 'playback_status' } = {}) {
  const now = Date.now();
  if (!force && playbackSnapshot.fetchedAt && now - playbackSnapshot.fetchedAt < PLAYBACK_SNAPSHOT_CACHE_MS) {
    return playbackSnapshot.current;
  }
  if (playbackSnapshot.inFlight) return playbackSnapshot.inFlight;

  playbackSnapshot.inFlight = spotifyApi('/me/player', { reason })
    .then((current) => {
      lastLivePlaybackReadAt = Date.now();
      playbackSnapshot.current = current?.item
        ? {
            isPlaying: Boolean(current.is_playing),
            progressMs: current.progress_ms ?? 0,
            track: normalizeSpotifyTrack(current.item),
            contextUri: current.context?.uri ?? null,
            deviceId: current.device?.id ?? null,
            deviceName: current.device?.name ?? null
          }
        : null;
      playbackSnapshot.fetchedAt = Date.now();
      playbackSnapshot.optimistic = false;
      scheduleOptimisticTrackAdvance(playbackSnapshot.current);
      return playbackSnapshot.current;
    })
    .finally(() => {
      playbackSnapshot.inFlight = null;
    });
  return playbackSnapshot.inFlight;
}

export async function getCurrentPlaybackAfterReconnect() {
  const delays = config.playbackControlMode === 'easyjam'
    ? [0, 2_000]
    : RECONNECT_PLAYBACK_CHECK_DELAYS_MS;
  for (const [attempt, delayMs] of delays.entries()) {
    if (delayMs) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const playback = await getCurrentPlayback({ force: true, reason: 'host_reconnect_check' });
    if (playback) return playback;

    // A 204 response can be a short Spotify Connect/device transition immediately
    // after OAuth. Keep checking briefly before treating it as genuinely inactive.
    if (attempt === RECONNECT_PLAYBACK_CHECK_DELAYS_MS.length - 1) return null;
  }
  return null;
}

export async function maintainSpotifyPlayback() {
  if (
    !config.easyJamEnabled ||
    !config.autoStartPlayback ||
    !partyState.host.tokens?.accessToken ||
    !partyState.host.playlistId ||
    partyState.sync.playbackControlSuspended ||
    partyState.sync.inFlight
  ) {
    return { skipped: true };
  }

  const now = Date.now();
  const checkInterval = config.playbackControlMode === 'easyjam'
    ? EASYJAM_PLAYBACK_CHECK_INTERVAL_MS
    : 10_000;
  if (now - lastPlaybackMaintenanceCheckAt < checkInterval) {
    return { skipped: true, reason: 'Playback check interval has not elapsed' };
  }
  lastPlaybackMaintenanceCheckAt = now;

  const playback = await getCurrentPlayback({ reason: 'playback_maintenance' });
  if (!playback) {
    const waitingForExternalPlayback = Boolean(
      partyState.sync.returnToEasyJamPending || partyState.sync.protectedPlaybackUri
    );
    if (waitingForExternalPlayback) {
      const now = Date.now();
      partyState.sync.noActivePlaybackSince ??= now;
      if (now - partyState.sync.noActivePlaybackSince < EXTERNAL_PLAYBACK_END_CONFIRMATION_MS) {
        return { skipped: true, reason: 'Confirming that the external Spotify track has ended' };
      }

      // Spotify can return no active item for a moment at a track boundary. Once it
      // remains absent for two maintenance polls, continue the promised handoff.
      partyState.sync.protectedPlaybackUri = null;
      partyState.sync.noActivePlaybackSince = null;
      resumeAutomaticPlayback();
      return syncSpotifyPlaylist({ restartIfPaused: true, forceRestart: true });
    }
    if (
      partyState.sync.autoStarted ||
      partyState.sync.pendingHandoff ||
      partyState.sync.returnToEasyJamPending
    ) {
      pauseAutomaticPlayback();
    }
    return { skipped: true, reason: 'No active Spotify playback state' };
  }

  if (!playback.isPlaying) {
    pauseAutomaticPlayback();
    return { skipped: true, reason: 'Spotify playback is paused' };
  }

  partyState.sync.noActivePlaybackSince = null;

  const playbackUpdate = recordPlayback(playback);
  if (playbackUpdate.historyItem) {
    await savePlayedTrack(playbackUpdate.historyItem);
  }
  if (playbackUpdate.changed) {
    await saveLivePartyState();
  }
  if (playbackUpdate.removedItem) {
    partyState.sync.playlistRefreshPending = true;
  }
  if (partyState.sync.playlistRefreshPending) {
    return syncSpotifyPlaylist({ preserveCurrentTrack: true });
  }

  resumeAutomaticPlayback();
  if (partyState.sync.protectedPlaybackUri) {
    if (playback?.isPlaying && playback.track?.uri === partyState.sync.protectedPlaybackUri) {
      return { skipped: true, reason: 'Preserving the track active when EasyJAM connected' };
    }
    partyState.sync.protectedPlaybackUri = null;
    partyState.sync.returnToEasyJamPending = true;
  }
  const pendingHandoff = partyState.sync.pendingHandoff;
  if (pendingHandoff?.nextUri) {
    if (
      playback.isPlaying &&
      playback.track?.uri === pendingHandoff.currentUri
    ) {
      schedulePendingHandoff(playback);
      return { skipped: true, reason: 'Waiting for the current track before EasyJAM handoff' };
    }

    const playbackIsManaged = isPlaybackManagedByEasyJam(playback);
    if (
      playbackIsManaged
    ) {
      // Spotify can progress naturally before our safety check sees the exact
      // handoff target. Any current track in the managed playlist proves that
      // the old handoff is stale; do not restart its previous target.
      partyState.sync.pendingHandoff = null;
      clearPendingHandoffTimer();
    } else {
      return syncSpotifyPlaylist({
        forceRestart: true,
        startAtUri: pendingHandoff.nextUri
      });
    }
  }

  const outsideEasyJam = !isPlaybackManagedByEasyJam(playback);
  if (outsideEasyJam && playback.isPlaying) {
    partyState.sync.returnToEasyJamPending = true;
    return { skipped: true, reason: 'Waiting for external Spotify track to finish' };
  }

  if (partyState.sync.returnToEasyJamPending || outsideEasyJam) {
    const result = await syncSpotifyPlaylist({ restartIfPaused: true, forceRestart: true });
    partyState.sync.returnToEasyJamPending = false;
    return result;
  }

  if (partyState.sync.lastPlaylistUris.at(-1) === playback.track?.uri) {
    return syncSpotifyPlaylist({
      ensureFallbackTail: true,
      currentTrackUri: playback.track?.uri
    });
  }

  return { skipped: true, reason: 'Playback has a next EasyJAM track' };
}

export async function reschedulePendingHandoff() {
  if (config.playbackControlMode === 'easyjam' && playbackSnapshot.current?.isPlaying) {
    clearOptimisticTrackAdvanceTimer();
    scheduleOptimisticTrackAdvance(playbackSnapshot.current);
    return;
  }

  const pendingHandoff = partyState.sync.pendingHandoff;
  if (!pendingHandoff?.currentUri || partyState.sync.inFlight) return;

  const playback = await getCurrentPlayback({ force: true, reason: 'handoff_reschedule_check' });
  if (playback?.isPlaying && playback.track?.uri === pendingHandoff.currentUri) {
    schedulePendingHandoff(playback);
  }
}

export async function searchTracks(query, limit = 12) {
  const normalizedLimit = Math.min(Math.max(Number(limit) || 12, 1), 30);
  const params = new URLSearchParams({
    type: 'track',
    q: query
  });
  const result = await spotifyApi(`/search?${params.toString()}`, { reason: 'track_search' });
  return (
    result.tracks?.items?.map(normalizeSpotifyTrack).filter(Boolean).slice(0, normalizedLimit) ??
    []
  );
}

export async function getPlaylist(playlistId) {
  return spotifyApi(`/playlists/${playlistId}`, { reason: 'playlist_metadata_lookup' });
}

export async function getPlaylistTracks(playlistId, offset = 0, limit = 30, refresh = false) {
  const params = new URLSearchParams({
    offset: String(Math.max(Number(offset) || 0, 0)),
    limit: String(Math.min(Math.max(Number(limit) || 30, 1), 50)),
    fields:
      'items(added_at,item(id,name,uri,duration_ms,explicit,artists(name),album(name,images))),next,total,offset,limit'
  });
  const result = await getCachedPlaylistItems(
    `/playlists/${playlistId}/items?${params.toString()}`,
    PLAYLIST_ITEMS_CACHE_MS,
    { force: refresh, reason: refresh ? 'playlist_browsing_refresh' : 'playlist_browsing' }
  );
  return {
    total: result.total ?? 0,
    offset: result.offset ?? offset,
    limit: result.limit ?? limit,
    tracks:
      result.items
        ?.map((playlistItem) => normalizeSpotifyTrack(playlistItem.item, playlistItem))
        .filter((track) => track?.uri?.startsWith('spotify:track:')) ?? []
  };
}

export async function getRecommendations(seedTrackIds, limit = 20) {
  const seeds = seedTrackIds.filter(Boolean).slice(0, 5);
  if (!seeds.length) return [];

  const params = new URLSearchParams({
    seed_tracks: seeds.join(','),
    limit: String(Math.min(Math.max(Number(limit) || 20, 1), 30))
  });
  const result = await spotifyApi(`/recommendations?${params.toString()}`, { reason: 'recommendations' });
  return result.tracks?.map(normalizeSpotifyTrack).filter(Boolean) ?? [];
}
