import crypto from 'node:crypto';
import { config, spotifyScopes } from './config.js';
import {
  getCombinedQueue,
  partyState,
  setHostPlaylist,
  setHostTokens,
  setHostUser
} from './state.js';

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';
const RANDOM_FALLBACK_TRACK_COUNT = 2;
const RANDOM_FALLBACK_PAGE_SIZE = 50;
const FALLBACK_SAFETY_TRACK_COUNT = 2;
const HANDOFF_RESCHEDULE_TOLERANCE_MS = 100;
const PLAYLIST_ITEMS_CACHE_MS = 30_000;
const RANDOM_PAGE_CACHE_MS = 15_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;

let pendingHandoffTimer = null;
let spotifyRateLimitedUntil = 0;
const playlistItemsCache = new Map();

export async function refreshPinnedPlaylists() {
  if (!partyState.host.tokens?.accessToken || !partyState.pinnedPlaylists.length) {
    return { skipped: true, changed: false };
  }

  const snapshots = await Promise.allSettled(
    partyState.pinnedPlaylists.map((playlist) =>
      spotifyApi(
        `/playlists/${playlist.id}?fields=id,name,owner(display_name,id),images,url,external_urls(spotify),items(total)`
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
  const response = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: tokenAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(body)
  });
  const payload = await readSpotifyResponse(response);

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
  const now = Date.now();
  if (spotifyRateLimitedUntil > now) {
    const retryAfterSeconds = Math.ceil((spotifyRateLimitedUntil - now) / 1000);
    throw new SpotifyError(
      'Spotify rate limit is active. Try again shortly.',
      429,
      { method: options.method ?? 'GET', path },
      retryAfterSeconds
    );
  }

  const accessToken = await ensureAccessToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {})
    },
    body:
      options.body && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body
  });

  if (response.status === 204) return null;

  const payload = await readSpotifyResponse(response);

  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const retryAfterSeconds =
      Number(retryAfter) > 0
        ? Number(retryAfter)
        : response.status === 429
          ? Math.ceil(DEFAULT_RATE_LIMIT_BACKOFF_MS / 1000)
          : null;
    if (response.status === 429 && retryAfterSeconds) {
      spotifyRateLimitedUntil = Math.max(
        spotifyRateLimitedUntil,
        Date.now() + retryAfterSeconds * 1000
      );
    }
    throw new SpotifyError(
      payload?.error?.message ?? payload?.error_description ?? 'Spotify API request failed',
      response.status,
      {
        spotify: payload,
        method: options.method ?? 'GET',
        path
      },
      retryAfterSeconds
    );
  }

  return payload;
}

async function getCachedPlaylistItems(path, cacheMs) {
  const now = Date.now();
  const cached = playlistItemsCache.get(path);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = spotifyApi(path).catch((error) => {
    playlistItemsCache.delete(path);
    throw error;
  });
  playlistItemsCache.set(path, { expiresAt: now + cacheMs, promise });
  return promise;
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
  const me = await spotifyApi('/me');
  setHostUser(me);

  if (partyState.host.playlistId) {
    const playlist = await spotifyApi(`/playlists/${partyState.host.playlistId}`);
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
    }
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

function schedulePendingHandoff(playback) {
  const pendingHandoff = partyState.sync.pendingHandoff;
  if (!pendingHandoff?.nextUri || !playback?.track?.durationMs) return;

  clearPendingHandoffTimer();
  const remainingMs = Math.max(
    Number(playback.track.durationMs) - Number(playback.progressMs ?? 0),
    0
  );
  pendingHandoffTimer = setTimeout(() => {
    pendingHandoffTimer = null;
    void executePendingHandoff().catch((error) => {
      partyState.sync.lastError = {
        message: error.message,
        status: error.status ?? 500,
        details: error.details ?? null
      };
    });
  }, Math.max(remainingMs - config.handoffLeadMs, 0));
  pendingHandoffTimer.unref?.();
}

async function executePendingHandoff() {
  const pendingHandoff = partyState.sync.pendingHandoff;
  if (
    !config.autoStartPlayback ||
    partyState.sync.manualPause ||
    partyState.sync.playbackControlSuspended ||
    partyState.sync.protectedPlaybackUri ||
    !pendingHandoff?.nextUri ||
    partyState.sync.inFlight
  ) {
    return;
  }

  const playback = await getCurrentPlayback();
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

  await syncSpotifyPlaylist({
    forceRestart: true,
    startAtUri: pendingHandoff.nextUri
  });
}

function pauseAutomaticPlayback() {
  partyState.sync.manualPause = true;
  partyState.sync.returnToEasyJamPending = false;
  partyState.sync.pendingHandoff = null;
  partyState.sync.protectedPlaybackUri = null;
  clearPendingHandoffTimer();
}

function resumeAutomaticPlayback() {
  partyState.sync.manualPause = false;
}

export function protectCurrentPlayback(currentPlayback) {
  const trackUri = currentPlayback?.isPlaying ? currentPlayback.track?.uri : null;
  if (!trackUri) return false;

  partyState.sync.protectedPlaybackUri = trackUri;
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
      RANDOM_PAGE_CACHE_MS
    );
    const pageTracks = shuffle(
      result.items
        ?.map((playlistItem) => normalizeSpotifyTrack(playlistItem.item))
        .filter((track) => track?.uri?.startsWith('spotify:track:')) ?? []
    );

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
    startAtUri = null,
    currentTrackUri = null
  } = {}
) {
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
    currentPlaybackForSync = await getCurrentPlayback();
  }
  const easyJamContextUri = `spotify:playlist:${partyState.host.playlistId}`;
  const queueUris = queueItems.map((item) => item.track.uri);
  const currentPlaybackUri = currentPlaybackForSync?.track?.uri ?? null;
  const currentIsEasyJamFallback =
    currentPlaybackForSync?.isPlaying &&
    currentPlaybackForSync.contextUri === easyJamContextUri &&
    currentPlaybackUri &&
    !queueUris.includes(currentPlaybackUri);
  const currentIsExternalTrack =
    currentPlaybackForSync?.isPlaying &&
    currentPlaybackForSync.contextUri !== easyJamContextUri;
  const preserveCurrentExternal = Boolean(
    preserveExternalPlayback && currentIsExternalTrack
  );
  const currentFallbackUri = currentIsEasyJamFallback ? currentPlaybackUri : null;
  const preserveCurrentFallback = Boolean(preserveCurrentTrack && currentFallbackUri);
  const handoffNextUri = queueUris.find((uri) => uri !== currentPlaybackUri) ?? null;
  const deferSourceRestart =
    preserveCurrentFallback || preserveCurrentExternal ||
    Boolean(
      currentPlaybackForSync?.isPlaying &&
      currentPlaybackUri &&
      handoffNextUri &&
      (currentFallbackUri || currentIsExternalTrack || currentPlaybackForSync.contextUri === easyJamContextUri)
    );
  if (deferSourceRestart) {
    partyState.sync.pendingHandoff = {
      currentUri: currentPlaybackUri,
      nextUri: handoffNextUri
    };
  }
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
  partyState.sync.fallbackTracks = fallbackTracks;
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
      partyState.sync.fallbackTracks = nextFallback;
    } else {
      uris = retainedUris;
    }
  }
  const uriChunks = chunks(uris, 100);
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
    currentPlaybackForSync = await getCurrentPlayback();
    if (currentPlaybackForSync && !currentPlaybackForSync.isPlaying) {
      pauseAutomaticPlayback();
    }
  }

  partyState.sync.inFlight = true;
  partyState.sync.lastError = null;

  try {
    let replaceResult = null;
    if (uris.length) {
      replaceResult = await spotifyApi(`/playlists/${partyState.host.playlistId}/items`, {
        method: 'PUT',
        body: { uris: uriChunks[0] ?? [] }
      });

      for (const chunk of uriChunks.slice(1)) {
        await spotifyApi(`/playlists/${partyState.host.playlistId}/items`, {
          method: 'POST',
          body: { uris: chunk }
        });
      }
    }

    const verifyParams = new URLSearchParams({
      limit: '1',
      fields: 'total,items(item(uri))'
    });
    const verification = await spotifyApi(
      `/playlists/${partyState.host.playlistId}/items?${verifyParams.toString()}`
    );
    if (!uris.length && Number(verification?.total) > 0) {
      source = 'preserved';
    }
    partyState.sync.lastPlaylistUris = uris.length
      ? [...uris]
      : partyState.sync.lastPlaylistUris;

    let pausedOrOutsideEasyJam = false;
    let deferExternalPlayback = false;
    if (restartIfPaused && config.autoStartPlayback && !partyState.sync.manualPause) {
      const playback = await getCurrentPlayback();
      if (playback && !playback.isPlaying) {
        pauseAutomaticPlayback();
      }
      const easyJamContextUri = `spotify:playlist:${partyState.host.playlistId}`;
      const outsideEasyJam = playback && playback.contextUri !== easyJamContextUri;
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
      await startPlaylistPlayback(startAtUri);
      partyState.sync.autoStarted = true;
      partyState.sync.returnToEasyJamPending = false;
      partyState.sync.pendingHandoff = null;
      clearPendingHandoffTimer();
    }

    partyState.sync.lastSource = source;

    if (partyState.sync.pendingHandoff?.currentUri === currentPlaybackUri) {
      schedulePendingHandoff(currentPlaybackForSync);
    }

    partyState.sync.lastSyncedAt = new Date().toISOString();
    return {
      skipped: false,
      count: uris.length,
      source,
      playlistId: partyState.host.playlistId,
      snapshotId: replaceResult?.snapshot_id ?? null,
      verifiedTotal: verification?.total ?? null,
      firstUri: verification?.items?.[0]?.item?.uri ?? null
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

export async function startPlaylistPlayback(startAtUri = null) {
  if (!partyState.host.playlistId) {
    throw new SpotifyError('Host playlist is not ready', 400);
  }

  return spotifyApi('/me/player/play', {
    method: 'PUT',
    body: {
      context_uri: `spotify:playlist:${partyState.host.playlistId}`,
      ...(startAtUri ? { offset: { uri: startAtUri } } : {})
    }
  });
}

export async function resumeEasyJamPlayback() {
  resumeAutomaticPlayback();
  partyState.sync.returnToEasyJamPending = false;
  partyState.sync.pendingHandoff = null;
  partyState.sync.protectedPlaybackUri = null;
  clearPendingHandoffTimer();
  const result = await startPlaylistPlayback();
  partyState.sync.autoStarted = true;
  return result;
}

export async function getCurrentPlayback() {
  const current = await spotifyApi('/me/player');
  if (!current?.item) return null;

  return {
    isPlaying: Boolean(current.is_playing),
    progressMs: current.progress_ms ?? 0,
    track: normalizeSpotifyTrack(current.item),
    contextUri: current.context?.uri ?? null,
    deviceId: current.device?.id ?? null,
    deviceName: current.device?.name ?? null
  };
}

export async function maintainSpotifyPlayback() {
  if (
    !config.autoStartPlayback ||
    !partyState.host.tokens?.accessToken ||
    !partyState.host.playlistId ||
    partyState.sync.playbackControlSuspended ||
    partyState.sync.inFlight
  ) {
    return { skipped: true };
  }

  const playback = await getCurrentPlayback();
  if (!playback) {
    if (
      partyState.sync.autoStarted ||
      partyState.sync.pendingHandoff ||
      partyState.sync.returnToEasyJamPending ||
      partyState.sync.protectedPlaybackUri
    ) {
      pauseAutomaticPlayback();
    }
    return { skipped: true, reason: 'No active Spotify playback state' };
  }

  if (!playback.isPlaying) {
    pauseAutomaticPlayback();
    return { skipped: true, reason: 'Spotify playback is paused' };
  }

  resumeAutomaticPlayback();
  if (partyState.sync.protectedPlaybackUri) {
    if (playback?.isPlaying && playback.track?.uri === partyState.sync.protectedPlaybackUri) {
      return { skipped: true, reason: 'Preserving the track active when EasyJAM connected' };
    }
    partyState.sync.protectedPlaybackUri = null;
    partyState.sync.returnToEasyJamPending = true;
  }
  const easyJamContextUri = `spotify:playlist:${partyState.host.playlistId}`;
  const pendingHandoff = partyState.sync.pendingHandoff;
  if (pendingHandoff?.nextUri) {
    if (
      playback.isPlaying &&
      playback.track?.uri === pendingHandoff.currentUri
    ) {
      schedulePendingHandoff(playback);
      return { skipped: true, reason: 'Waiting for the current track before EasyJAM handoff' };
    }

    if (
      playback.isPlaying &&
      playback.contextUri === easyJamContextUri &&
      playback.track?.uri === pendingHandoff.nextUri
    ) {
      partyState.sync.pendingHandoff = null;
      clearPendingHandoffTimer();
    } else {
      return syncSpotifyPlaylist({
        forceRestart: true,
        startAtUri: pendingHandoff.nextUri
      });
    }
  }

  const outsideEasyJam = playback.contextUri !== easyJamContextUri;
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
  const pendingHandoff = partyState.sync.pendingHandoff;
  if (!pendingHandoff?.currentUri || partyState.sync.inFlight) return;

  const playback = await getCurrentPlayback();
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
  const result = await spotifyApi(`/search?${params.toString()}`);
  return (
    result.tracks?.items?.map(normalizeSpotifyTrack).filter(Boolean).slice(0, normalizedLimit) ??
    []
  );
}

export async function getPlaylist(playlistId) {
  return spotifyApi(`/playlists/${playlistId}`);
}

export async function getPlaylistTracks(playlistId, offset = 0, limit = 30) {
  const params = new URLSearchParams({
    offset: String(Math.max(Number(offset) || 0, 0)),
    limit: String(Math.min(Math.max(Number(limit) || 30, 1), 50)),
    fields:
      'items(added_at,item(id,name,uri,duration_ms,explicit,artists(name),album(name,images))),next,total,offset,limit'
  });
  const result = await getCachedPlaylistItems(
    `/playlists/${playlistId}/items?${params.toString()}`,
    PLAYLIST_ITEMS_CACHE_MS
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
  const result = await spotifyApi(`/recommendations?${params.toString()}`);
  return result.tracks?.map(normalizeSpotifyTrack).filter(Boolean) ?? [];
}
