import crypto from 'node:crypto';
import express from 'express';
import {
  config,
  hasSpotifyCredentials,
  saveAutoStartPlayback,
  saveSpotifyPlaylistId,
  saveSpotifySetup,
  setHandoffLeadMs,
  setPlaybackControlMode
} from './config.js';
import {
  addPinnedPlaylist,
  addTrackForGuest,
  banGuest,
  getBannedGuests,
  getCombinedQueue,
  getGuests,
  getGuestQueue,
  getGuestStats,
  getVisibleQueue,
  getRequestStats,
  getRequesterStats,
  resetRequesterStats,
  getDisplayInviteUrl,
  hasInviteAccess,
  parseSpotifyPlaylistId,
  partyState,
  removeItem,
  removeAllGuests,
  removeGuest,
  removePinnedPlaylist,
  recordPlayback,
  resetManualOrder,
  rotateInviteToken,
  serializePlaybackItem,
  serializeInvite,
  serializeQueueItem,
  serializeQueues,
  setAdminToken,
  setGuestName,
  setHostPlaylist,
  setInviteSettings,
  setManualOrder,
  setQueueMode,
  setPinnedPlaylistFallbackEnabled,
  setPinnedPlaylistVisibleToGuests,
  setRandomFallbackEnabled,
  unbanGuest,
  verifyInvite
} from './state.js';
import {
  bootstrapHostPlaylist,
  cancelEasyJamPlaybackHandoff,
  cancelScheduledSpotifySync,
  createAuthorizationUrl,
  clearSpotifyRequestLog,
  exportSpotifyRequestLogText,
  exchangeCodeForTokens,
  getCachedCurrentPlayback,
  getCurrentPlayback,
  getCurrentPlaybackAfterReconnect,
  getAvailableSpotifyDevices,
  getSpotifyRequestLog,
  getPlaylist,
  getPlaylistTracks,
  getRecommendations,
  pauseSpotifyPlayback,
  protectCurrentPlayback,
  refreshPinnedPlaylists,
  resumeEasyJamPlayback,
  reschedulePendingHandoff,
  scheduleSpotifySync,
  searchTracks,
  seekSpotifyPlayback,
  skipSpotifyTrack,
  SpotifyError,
  switchSpotifyPlaybackDevice,
  syncSpotifyPlaylist
} from './spotify.js';
import {
  getGuestPlaylists,
  getPlayedTrackLog,
  saveGuestPlaylists,
  saveAutoStartPlaybackState,
  savePlaybackControlModeState,
  saveHandoffLeadState,
  saveHostPlaylistState,
  saveInviteState,
  saveLeaderboardResetState,
  saveLivePartyState,
  savePinnedPlaylists,
  savePlayedTrack,
  saveRandomFallbackState
} from './storage.js';

export const router = express.Router();

const playbackCache = {
  current: null,
  fetchedAt: 0,
  rateLimitedUntil: 0,
  lastError: null
};

function updatePlaybackCache(current) {
  playbackCache.current = current;
  playbackCache.fetchedAt = Date.now();
  playbackCache.rateLimitedUntil = 0;
  playbackCache.lastError = null;
}

function rateLimitedPlaybackResponse(now) {
  return {
    current: playbackCache.current,
    cached: true,
    playbackUnavailable: !playbackCache.current,
    rateLimited: true,
    retryAfterSeconds: Math.ceil((playbackCache.rateLimitedUntil - now) / 1000)
  };
}

const EXTERNAL_PLAYBACK_CACHE_MS = 10_000;
const EASYJAM_PLAYBACK_CACHE_MS = 60_000;
const LIVE_PARTY_ACTIVITY_PERSIST_MS = 30_000;
let lastLivePartyActivityPersistedAt = 0;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000;
const ADMIN_ACCESS_COOKIE = 'easyjam_admin_access';
const ADMIN_ACCESS_SESSION_MS = 30 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ADMIN_ACCESS_ATTEMPTS = 8;
const MAX_INVITE_PIN_ATTEMPTS = 10;
const adminAccessSessions = new Map();
const failedAttempts = new Map();

function playbackCacheMs() {
  return config.playbackControlMode === 'easyjam'
    ? EASYJAM_PLAYBACK_CACHE_MS
    : EXTERNAL_PLAYBACK_CACHE_MS;
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requireAdmin(req, _res, next) {
  const token = req.get('x-admin-token') ?? req.query.adminToken;
  if (!partyState.host.adminToken || token !== partyState.host.adminToken) {
    const error = new Error('Admin token is required');
    error.status = 401;
    throw error;
  }
  next();
}

function requireEasyJamEnabled(_req, _res, next) {
  if (!config.easyJamEnabled) {
    const error = new Error('Enable EasyJAM in the admin panel first');
    error.status = 409;
    throw error;
  }
  next();
}

function requestAddress(req) {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

function consumeAttempt(kind, req, limit) {
  const key = `${kind}:${requestAddress(req)}`;
  const now = Date.now();
  const attempts = (failedAttempts.get(key) ?? []).filter(
    (attemptedAt) => now - attemptedAt < ATTEMPT_WINDOW_MS
  );

  if (attempts.length >= limit) {
    const error = new Error('Too many failed attempts. Try again later.');
    error.status = 429;
    throw error;
  }

  attempts.push(now);
  failedAttempts.set(key, attempts);
}

function clearAttempts(kind, req) {
  failedAttempts.delete(`${kind}:${requestAddress(req)}`);
}

function isLocalRequest(req) {
  const address = req.socket?.remoteAddress ?? '';
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
}

function hasAdminAccess(req) {
  const token = req.cookies?.[ADMIN_ACCESS_COOKIE];
  const expiresAt = adminAccessSessions.get(token);
  if (!token || !expiresAt) return false;
  if (expiresAt <= Date.now()) {
    adminAccessSessions.delete(token);
    return false;
  }
  return true;
}

function grantAdminAccess(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  adminAccessSessions.set(token, Date.now() + ADMIN_ACCESS_SESSION_MS);
  res.cookie(ADMIN_ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: ADMIN_ACCESS_SESSION_MS,
    path: '/api'
  });
}

function requireAdminAccess(req, _res, next) {
  if (!hasAdminAccess(req)) {
    const error = new Error('Admin access is required');
    error.status = 401;
    throw error;
  }
  next();
}

function requireInvite(req, _res, next) {
  const token =
    req.get('x-invite-token') ??
    req.query.inviteToken ??
    req.body?.inviteToken;
  const accessToken =
    req.get('x-invite-access-token') ??
    req.query.inviteAccessToken ??
    req.body?.inviteAccessToken;

  if (!hasInviteAccess(token, accessToken)) {
    if (String(token ?? '') === partyState.invite.token && partyState.invite.pinEnabled) {
      consumeAttempt('invite-pin', req, MAX_INVITE_PIN_ATTEMPTS);
    }
    const error = new Error('Invite PIN is required');
    error.status = 401;
    throw error;
  }

  next();
}

function requireInviteOrAdmin(req, res, next) {
  const adminToken = req.get('x-admin-token') ?? req.query.adminToken;
  if (partyState.host.adminToken && adminToken === partyState.host.adminToken) {
    return next();
  }
  return requireInvite(req, res, next);
}
async function syncAfterMutation(options = {}, { immediate = false } = {}) {
  if (!immediate) return scheduleSpotifySync(options);

  cancelScheduledSpotifySync();
  try {
    return await syncSpotifyPlaylist(options);
  } catch (error) {
    if (error instanceof SpotifyError) {
      console.warn(
        `EasyJam Spotify sync error: HTTP ${error.status ?? 500} ${
          error.details?.method ?? ''
        } ${error.details?.path ?? ''} ${error.message}`.trim()
      );
    }
    return {
      skipped: false,
      error: {
        message: error.message,
        status: error.status ?? 500,
        details: error.details ?? null
      }
    };
  }
}

function hostStatus() {
  return {
    authenticated: Boolean(partyState.host.tokens?.accessToken),
    user: partyState.host.user
      ? {
          id: partyState.host.user.id,
          displayName: partyState.host.user.display_name,
          image: partyState.host.user.images?.[0]?.url ?? null
        }
      : null,
    playlistId: partyState.host.playlistId,
    playlistUrl: partyState.host.playlistUrl,
    playlistOwnerId: partyState.host.playlistOwnerId,
    playlistOwnerName: partyState.host.playlistOwnerName,
    playlistPublic: partyState.host.playlistPublic,
    playlistCollaborative: partyState.host.playlistCollaborative,
    autoStartPlayback: config.autoStartPlayback,
    easyJamEnabled: config.easyJamEnabled,
    playbackDevice: partyState.host.playbackDevice
      ? {
          id: partyState.host.playbackDevice.id,
          name: partyState.host.playbackDevice.name,
          type: partyState.host.playbackDevice.type,
          isActive: partyState.host.playbackDevice.isActive
        }
      : null,
    playbackControlMode: config.playbackControlMode,
    handoffLeadMs: config.handoffLeadMs,
    spotifyConfigured: hasSpotifyCredentials(),
    spotifyRedirectUri: config.spotifyRedirectUri,
    adminAccessConfigured: Boolean(config.adminAccessKey)
  };
}

function inviteStatus(req, includeSecret = false) {
  return serializeInvite(req, includeSecret);
}

function randomFallbackStatus() {
  return {
    enabled: partyState.randomFallback.enabled,
    playlistCount: partyState.pinnedPlaylists.length
  };
}

function csvCell(value) {
  const rawText = String(value ?? '');
  const text = /^[\t\r ]*[=+\-@]/.test(rawText) ? `'${rawText}` : rawText;
  return `"${text.replaceAll('"', '""')}"`;
}

function requesterDetails(item) {
  const requesterType =
    item.requesterType ?? (item.guestId === 'spotify' ? 'spotify' : 'visitor');
  const requesterName =
    item.guestName ||
    (requesterType === 'easyjam_fallback'
      ? 'EasyJAM fallback'
      : requesterType === 'spotify'
        ? 'Spotify'
        : `Guest ${item.guestId.slice(0, 6)}`);
  return { requesterName, requesterType };
}

function localTimestamp(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23'
  }).format(date).replace(' ', 'T');
}

function playedTrackLogCsv(history) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const header = [
    'log_entry_id',
    'jam_id',
    'playback_event',
    'played_at_utc',
    'played_at_local',
    'timezone',
    'requested_at_utc',
    'track_name',
    'artists',
    'album',
    'track_uri',
    'track_id',
    'requester_name',
    'requester_type',
    'guest_id',
    'duration_ms',
    'explicit'
  ];
  const rows = history.map((item) => {
    const { requesterName, requesterType } = requesterDetails(item);
    return [
      item.id,
      item.jamId,
      'playback_observed',
      item.addedAt,
      localTimestamp(item.addedAt, timeZone),
      timeZone,
      requesterType === 'visitor' ? item.requestedAt : '',
      item.track.name,
      item.track.artists?.join('; ') ?? '',
      item.track.album,
      item.track.uri,
      item.track.id,
      requesterName,
      requesterType,
      item.guestId,
      item.track.durationMs,
      item.track.explicit
    ];
  });

  return `\uFEFF${[header, ...rows]
    .map((row) => row.map(csvCell).join(','))
    .join('\r\n')}`;
}

router.post('/admin/access', (req, res) => {
  if (!config.adminAccessKey && isLocalRequest(req)) {
    grantAdminAccess(req, res);
    res.json({ ok: true, localOnly: true });
    return;
  }

  if (config.adminAccessKey && req.body?.accessKey === config.adminAccessKey) {
    clearAttempts('admin-access', req);
    grantAdminAccess(req, res);
    res.json({ ok: true, localOnly: false });
    return;
  }

  consumeAttempt('admin-access', req, MAX_ADMIN_ACCESS_ATTEMPTS);
  const error = new Error('Admin access key is required');
  error.status = 401;
  throw error;
});

router.get('/admin/access/status', requireAdminAccess, (_req, res) => {
  res.json({ ok: true });
});

router.get('/health', (_req, res) => {
  res.json({ ok: true });
});

router.get('/invite/status', (req, res) => {
  const token = String(req.query.token ?? '');
  res.json({
    ...inviteStatus(req, false),
    validToken: token ? token === partyState.invite.token : false
  });
});

router.post('/invite/verify', (req, res) => {
  try {
    const accessToken = verifyInvite(req.body?.token, req.body?.pin);
    clearAttempts('invite-pin', req);
    res.json({
      ok: true,
      accessToken,
      invite: inviteStatus(req, false)
    });
  } catch (error) {
    if (String(req.body?.token ?? '') === partyState.invite.token && partyState.invite.pinEnabled) {
      consumeAttempt('invite-pin', req, MAX_INVITE_PIN_ATTEMPTS);
    }
    throw error;
  }
});

router.get('/auth/login', requireAdminAccess, (req, res, next) => {
  try {
    if (!hasSpotifyCredentials()) {
      const redirectUrl = new URL('/admin', `${req.protocol}://${req.get('host')}`);
      redirectUrl.searchParams.set('setup', 'spotify');
      res.redirect(redirectUrl.toString());
      return;
    }

    res.redirect(createAuthorizationUrl());
  } catch (error) {
    next(error);
  }
});

router.get(
  '/auth/callback',
  requireAdminAccess,
  asyncHandler(async (req, res) => {
    const { code, state, error } = req.query;
    if (error) throw new SpotifyError(String(error), 400);
    if (!code || state !== partyState.host.oauthState) {
      throw new SpotifyError('Invalid Spotify OAuth callback state', 400);
    }

    partyState.sync.playbackControlSuspended = true;
    try {
      await exchangeCodeForTokens(String(code));
      setAdminToken(crypto.randomBytes(32).toString('hex'));

      const redirectUrl = new URL('/admin', config.frontendUrl);
      redirectUrl.searchParams.set('auth', 'success');
      redirectUrl.searchParams.set('adminToken', partyState.host.adminToken);

      try {
        if (!config.easyJamEnabled) {
          res.redirect(redirectUrl.toString());
          return;
        }
        await bootstrapHostPlaylist();
        await saveHostPlaylistState();
        const currentPlayback = await getCurrentPlaybackAfterReconnect();
        updatePlaybackCache(currentPlayback);
        const shouldProtectCurrentPlayback = Boolean(currentPlayback?.isPlaying);
        if (shouldProtectCurrentPlayback) {
          partyState.sync.returnToEasyJamPending = true;
          protectCurrentPlayback(currentPlayback);
        }
        await syncAfterMutation({
          restartIfPaused: true,
          deferToCurrentTrack: true,
          preserveExternalPlayback: true,
          suppressPlaybackStart: shouldProtectCurrentPlayback
        }, { immediate: true });
      } catch (bootstrapError) {
        partyState.sync.lastError = {
          message: bootstrapError.message,
          status: bootstrapError.status ?? 500
        };
        redirectUrl.searchParams.set('auth', 'partial');
        redirectUrl.searchParams.set('setup', 'playlist');
        redirectUrl.searchParams.set(
          'spotifyError',
          bootstrapError.message || 'Spotify playlist setup failed'
        );
      }

      res.redirect(redirectUrl.toString());
    } finally {
      partyState.sync.playbackControlSuspended = false;
    }
  })
);

router.get('/session', (req, res) => {
  const inviteToken = req.get('x-invite-token') ?? req.query.inviteToken;
  const inviteAccessToken =
    req.get('x-invite-access-token') ?? req.query.inviteAccessToken;

  res.json({
    host: hostStatus(),
    pinnedPlaylists: partyState.pinnedPlaylists.filter(
      (playlist) => playlist.visibleToGuests !== false
    ),
    queue: getVisibleQueue().map(serializeQueueItem),
    guestStats: getGuestStats(),
    requestStats: getRequestStats(),
    requesterStats: getRequesterStats(),
    displayInviteUrl: hasInviteAccess(inviteToken, inviteAccessToken)
      ? getDisplayInviteUrl(req)
      : null,
    manualOrderActive: Boolean(partyState.manualOrder?.length),
    queueMode: partyState.queueMode,
    randomFallback: randomFallbackStatus(),
    autoStartPlayback: config.autoStartPlayback,
    sync: partyState.sync,
    invite: serializeInvite(null, false)
  });
});

router.post(
  '/setup/spotify',
  requireAdminAccess,
  asyncHandler(async (req, res) => {
    const saved = await saveSpotifySetup(req.body);
    res.json({
      ok: true,
      saved,
      host: hostStatus()
    });
  })
);

router.get('/admin/status', requireAdmin, (req, res) => {
  res.json({
    host: hostStatus(),
    queue: getVisibleQueue().map(serializeQueueItem),
    guestStats: getGuestStats(),
    guests: getGuests(),
    bannedGuests: getBannedGuests(),
    pinnedPlaylists: partyState.pinnedPlaylists,
    manualOrderActive: Boolean(partyState.manualOrder?.length),
    queueMode: partyState.queueMode,
    randomFallback: randomFallbackStatus(),
    sync: partyState.sync,
    invite: serializeInvite(req, true)
  });
});

router.get('/admin/spotify/request-log', requireAdmin, (_req, res) => {
  res.json(getSpotifyRequestLog());
});

router.get('/admin/spotify/request-log/export', requireAdmin, (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  res
    .type('text/plain')
    .attachment(`easyjam-spotify-diagnostics-${timestamp}.txt`)
    .send(exportSpotifyRequestLogText());
});

router.delete('/admin/spotify/request-log', requireAdmin, (_req, res) => {
  clearSpotifyRequestLog();
  res.status(204).end();
});

router.delete('/admin/guests/:guestId', requireAdmin, asyncHandler(async (req, res) => {
  removeGuest(req.params.guestId);
  await saveLivePartyState();
  const spotifySync = await syncAfterMutation();
  res.json({
    guests: getGuests(),
    guestStats: getGuestStats(),
    queue: getCombinedQueue().map(serializeQueueItem),
    spotifySync,
    sync: partyState.sync
  });
}));

router.delete('/admin/guests', requireAdmin, asyncHandler(async (_req, res) => {
  const removedCount = removeAllGuests();
  await saveLivePartyState();
  const spotifySync = await syncAfterMutation();
  res.json({
    removedCount,
    guests: getGuests(),
    guestStats: getGuestStats(),
    queue: getCombinedQueue().map(serializeQueueItem),
    spotifySync,
    sync: partyState.sync
  });
}));

router.post('/admin/guests/:guestId/ban', requireAdmin, asyncHandler(async (req, res) => {
  banGuest(req.params.guestId);
  await saveLivePartyState();
  const spotifySync = await syncAfterMutation();
  res.json({
    guests: getGuests(),
    bannedGuests: getBannedGuests(),
    guestStats: getGuestStats(),
    queue: getCombinedQueue().map(serializeQueueItem),
    spotifySync,
    sync: partyState.sync
  });
}));

router.delete('/admin/banned-guests/:guestId', requireAdmin, asyncHandler(async (req, res) => {
  unbanGuest(req.params.guestId);
  await saveLivePartyState();
  res.json({ bannedGuests: getBannedGuests() });
}));

router.post('/admin/random-fallback', requireAdmin, asyncHandler(async (req, res) => {
  const randomFallback = setRandomFallbackEnabled(req.body?.enabled);
  await saveRandomFallbackState();
  const spotifySync = await syncAfterMutation();
  res.json({
    randomFallback: randomFallbackStatus(),
    spotifySync,
    sync: partyState.sync
  });
}));

router.post('/admin/auto-playback', requireAdmin, asyncHandler(async (req, res) => {
  const autoStartPlayback = await saveAutoStartPlayback(req.body?.enabled);
  await saveAutoStartPlaybackState();
  const spotifySync = autoStartPlayback.autoStartPlayback
    ? await syncAfterMutation({ restartIfPaused: true }, { immediate: true })
    : null;
  res.json({ autoStartPlayback, spotifySync, sync: partyState.sync });
}));

router.get('/admin/playback/devices', requireAdmin, asyncHandler(async (_req, res) => {
  res.json({ devices: await getAvailableSpotifyDevices() });
}));

router.post('/admin/playback/device', requireAdmin, requireEasyJamEnabled, asyncHandler(async (req, res) => {
  const playbackDevice = await switchSpotifyPlaybackDevice(req.body?.deviceId);
  res.json({ playbackDevice, host: hostStatus() });
}));

router.post('/admin/easyjam-enabled', requireAdmin, asyncHandler(async (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  let spotifySync = null;
  if (enabled) {
    const devices = await getAvailableSpotifyDevices();
    const device = devices.find((candidate) => candidate.id === req.body?.deviceId);
    if (!device) {
      const error = new Error('Choose an available Spotify Connect device before enabling EasyJAM');
      error.status = 409;
      throw error;
    }

    // Selecting a Spotify Connect target does not itself tell us what Spotify is
    // currently playing. Read it once before enabling automatic control so an
    // already-playing track is preserved rather than replaced from a stale or
    // optimistic player snapshot. The following sync reuses this shared cache.
    const currentPlayback = await getCurrentPlayback({
      force: true,
      reason: 'easyjam_enable_playback_check'
    });
    updatePlaybackCache(currentPlayback);
    const shouldProtectCurrentPlayback = Boolean(currentPlayback?.isPlaying);
    partyState.host.playbackDevice = device;
    // A previous host setup may have protected a track while EasyJAM was off.
    // Enabling starts a new, explicitly scheduled handoff instead.
    partyState.sync.pendingHandoff = null;
    partyState.sync.protectedPlaybackUri = null;
    partyState.sync.noActivePlaybackSince = null;
    config.easyJamEnabled = true;
    spotifySync = await syncAfterMutation({
      forceRestart: !shouldProtectCurrentPlayback,
      restartIfPaused: true,
      deferToCurrentTrack: true,
      preserveExternalPlayback: true,
      suppressPlaybackStart: shouldProtectCurrentPlayback
    }, { immediate: true });
    if (spotifySync?.error) {
      config.easyJamEnabled = false;
      partyState.host.playbackDevice = null;
      cancelEasyJamPlaybackHandoff();
    }
  } else {
    config.easyJamEnabled = false;
    partyState.host.playbackDevice = null;
    cancelScheduledSpotifySync();
    cancelEasyJamPlaybackHandoff();
  }
  res.json({ easyJamEnabled: config.easyJamEnabled, spotifySync, host: hostStatus(), sync: partyState.sync });
}));

router.post('/admin/playback-control-mode', requireAdmin, asyncHandler(async (req, res) => {
  const playbackControlMode = setPlaybackControlMode(req.body?.mode);
  if (playbackControlMode !== 'easyjam') cancelEasyJamPlaybackHandoff();
  await savePlaybackControlModeState();
  res.json({ playbackControlMode, host: hostStatus(), sync: partyState.sync });
}));

router.post('/admin/handoff-lead', requireAdmin, asyncHandler(async (req, res) => {
  const handoffLeadMs = setHandoffLeadMs(req.body?.handoffLeadMs);
  await saveHandoffLeadState();
  await reschedulePendingHandoff();
  res.json({ handoffLeadMs });
}));

router.post('/admin/invite', requireAdmin, asyncHandler(async (req, res) => {
  setInviteSettings({
    pin: req.body?.pin,
    pinEnabled: req.body?.pinEnabled,
    guestsCanInvite: req.body?.guestsCanInvite,
    playlistLinksEnabled: req.body?.playlistLinksEnabled
  });
  await saveInviteState();
  res.json({ invite: inviteStatus(req, true) });
}));

router.post('/admin/invite/rotate', requireAdmin, asyncHandler(async (req, res) => {
  rotateInviteToken();
  await saveInviteState();
  res.json({ invite: inviteStatus(req, true) });
}));

router.get(
  '/player/current',
  asyncHandler(async (_req, res) => {
    const now = Date.now();

    if (!config.easyJamEnabled) {
      res.json({ current: null, disabled: true });
      return;
    }

    if (!partyState.host.tokens?.accessToken) {
      res.json({ current: null });
      return;
    }

    if (playbackCache.rateLimitedUntil > now) {
      res.json(rateLimitedPlaybackResponse(now));
      return;
    }

    const sharedPlayback = getCachedCurrentPlayback();
    if (sharedPlayback.fetchedAt > playbackCache.fetchedAt) {
      playbackCache.current = sharedPlayback.current;
      playbackCache.fetchedAt = sharedPlayback.fetchedAt;
      playbackCache.lastError = null;
      res.json({
        current: playbackCache.current,
        cached: true,
        optimistic: sharedPlayback.optimistic
      });
      return;
    }

    if (playbackCache.fetchedAt && now - playbackCache.fetchedAt < playbackCacheMs()) {
      res.json({ current: playbackCache.current, cached: true });
      return;
    }

    try {
      playbackCache.current = await getCurrentPlayback({ reason: 'player_status_refresh' });
      let spotifySync = null;
      const playbackUpdate = recordPlayback(playbackCache.current);
      if (playbackCache.current?.track) {
        const easyJamContextUri = partyState.host.playlistId
          ? `spotify:playlist:${partyState.host.playlistId}`
          : null;
        const isEasyJamPlayback = Boolean(
          easyJamContextUri && playbackCache.current.contextUri === easyJamContextUri
        );
        const currentQueueItem = isEasyJamPlayback
          ? getCombinedQueue().find((item) => item.track.id === playbackCache.current.track.id)
          : null;
        const isFallbackTrack =
          isEasyJamPlayback &&
          partyState.sync.fallbackTracks.some(
            (track) => track.uri === playbackCache.current.track.uri
          );
        playbackCache.current = {
          ...playbackCache.current,
          guestLabel: currentQueueItem
            ? serializeQueueItem(currentQueueItem).guestLabel
            : isFallbackTrack
              ? 'EasyJAM fallback'
              : 'Spotify'
        };
      }
      if (playbackUpdate.historyItem) {
        await savePlayedTrack(playbackUpdate.historyItem);
      }
      if (playbackUpdate.changed) {
        await saveLivePartyState();
      }
      if (playbackUpdate.removedItem) {
        spotifySync = await syncAfterMutation({ preserveCurrentTrack: true });
      }
      playbackCache.fetchedAt = now;
      playbackCache.lastError = null;
      res.json({
        current: playbackCache.current,
        cached: false,
        playbackUpdate,
        spotifySync
      });
    } catch (error) {
      if (error.status === 429) {
        const retryAfterMs =
          Number(error.retryAfterSeconds) > 0
            ? Number(error.retryAfterSeconds) * 1000
            : DEFAULT_RATE_LIMIT_BACKOFF_MS;
        playbackCache.rateLimitedUntil = now + retryAfterMs;
        playbackCache.lastError = {
          message: error.message,
          status: error.status,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000)
        };

        res.json({
          current: playbackCache.current,
          cached: true,
          playbackUnavailable: !playbackCache.current,
          rateLimited: true,
          retryAfterSeconds: Math.ceil(retryAfterMs / 1000)
        });
        return;
      }

      throw error;
    }
  })
);

router.get('/admin/playback/history', requireAdmin, asyncHandler(async (req, res) => {
  const history = await getPlayedTrackLog({
    limit: req.query.limit,
    offset: req.query.offset
  });
  res.json({ history: history.map(serializePlaybackItem) });
}));

router.get(
  '/admin/playback/history/export',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const history = await getPlayedTrackLog({
      all: true,
      from: req.query.from,
      to: req.query.to
    });
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const exportedAt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="easyjam-played-log-${exportedAt}.csv"`
    );
    res.send(playedTrackLogCsv(history));
  })
);

router.get(
  '/search',
  requireInvite,
  asyncHandler(async (req, res) => {
    const query = String(req.query.query ?? '').trim();
    if (query.length < 2) {
      res.json({ tracks: [] });
      return;
    }

    res.json({ tracks: await searchTracks(query, req.query.limit) });
  })
);

router.get('/queue', requireInvite, asyncHandler(async (req, res) => {
  const guestId = req.query.guestId ? String(req.query.guestId) : null;
  const queues = serializeQueues(guestId);
  const now = Date.now();
  if (guestId && now - lastLivePartyActivityPersistedAt >= LIVE_PARTY_ACTIVITY_PERSIST_MS) {
    lastLivePartyActivityPersistedAt = now;
    await saveLivePartyState();
  }
  res.json(queues);
}));

router.post('/guests/:guestId/name', requireInvite, asyncHandler(async (req, res) => {
  const guest = setGuestName(req.params.guestId, req.body?.name);
  await saveLivePartyState();
  res.json({
    guest: {
      id: guest.id,
      name: guest.name
    },
    ...serializeQueues(guest.id)
  });
}));

router.get(
  '/guests/:guestId/playlists',
  requireInvite,
  asyncHandler(async (req, res) => {
    res.json({ playlists: await getGuestPlaylists(req.params.guestId) });
  })
);

router.put(
  '/guests/:guestId/playlists',
  requireInvite,
  asyncHandler(async (req, res) => {
    const playlists = await saveGuestPlaylists(
      req.params.guestId,
      req.body?.playlists
    );
    res.json({ playlists });
  })
);

router.post(
  '/queue/items',
  requireInvite,
  asyncHandler(async (req, res) => {
    const item = addTrackForGuest(
      req.body.guestId,
      req.body.track,
      req.body.guestName
    );
    await saveLivePartyState();
    const spotifySync = await syncAfterMutation({
      restartIfPaused: true,
      deferToCurrentTrack: true,
      preserveExternalPlayback: true
    });
    res.status(201).json({
      item: serializeQueueItem(item),
      ...serializeQueues(req.body.guestId),
      spotifySync
    });
  })
);

router.delete(
  '/queue/items/:itemId',
  requireInvite,
  asyncHandler(async (req, res) => {
    const guestId = req.query.guestId ? String(req.query.guestId) : null;
    removeItem(req.params.itemId, guestId);
    await saveLivePartyState();
    const spotifySync = await syncAfterMutation();
    res.json({
      ...serializeQueues(guestId),
      spotifySync
    });
  })
);

router.get(
  '/recommendations',
  requireInvite,
  asyncHandler(async (req, res) => {
    const guestId = String(req.query.guestId ?? '');
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 30);
    const mine = getGuestQueue(guestId);
    const seeds = mine.slice(-5).map((item) => item.track.id);

    if (!mine.length) {
      res.json({ tracks: [], fallback: false });
      return;
    }

    try {
      res.json({
        tracks: await getRecommendations(seeds, limit),
        fallback: false
      });
      return;
    } catch (error) {
      if (![403, 404].includes(error.status)) throw error;
    }

    const existingUris = new Set(mine.map((item) => item.track.uri));
    const addedUris = new Set(existingUris);
    const tracks = [];
    const fallbackSeeds = mine.slice(-5).reverse();

    for (const item of fallbackSeeds) {
      if (tracks.length >= limit) break;

      const artist = item.track.artists?.[0];
      const query = artist ? `artist:${artist}` : item.track.name;
      const results = await searchTracks(query, 12);

      for (const track of results) {
        if (tracks.length >= limit) break;
        if (!track?.uri || addedUris.has(track.uri)) continue;
        addedUris.add(track.uri);
        tracks.push(track);
      }
    }

    res.json({
      tracks,
      fallback: true,
      reason: 'Spotify recommendations endpoint unavailable; used search fallback'
    });
  })
);

router.post(
  '/admin/queue/mode',
  requireAdmin,
  asyncHandler(async (req, res) => {
    setQueueMode(req.body?.queueMode);
    await saveLivePartyState();
    res.json({
      queue: getCombinedQueue().map(serializeQueueItem),
      queueMode: partyState.queueMode,
      manualOrderActive: Boolean(partyState.manualOrder?.length),
      sync: partyState.sync
    });
  })
);

router.post(
  '/admin/queue/reorder',
  requireAdmin,
  asyncHandler(async (req, res) => {
    setManualOrder(req.body.orderedItemIds);
    await saveLivePartyState();
    const spotifySync = await syncAfterMutation();
    res.json({
      queue: getCombinedQueue().map(serializeQueueItem),
      manualOrderActive: true,
      spotifySync,
      sync: partyState.sync
    });
  })
);

router.post(
  '/admin/queue/reset-order',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    resetManualOrder();
    await saveLivePartyState();
    const spotifySync = await syncAfterMutation();
    res.json({
      queue: getCombinedQueue().map(serializeQueueItem),
      manualOrderActive: false,
      spotifySync,
      sync: partyState.sync
    });
  })
);

router.post('/admin/leaderboard/reset', requireAdmin, asyncHandler(async (_req, res) => {
  const resetAt = resetRequesterStats();
  await saveLeaderboardResetState();
  res.json({ ok: true, resetAt, requesterStats: getRequesterStats() });
}));

router.delete(
  '/admin/queue/items/:itemId',
  requireAdmin,
  asyncHandler(async (req, res) => {
    removeItem(req.params.itemId);
    await saveLivePartyState();
    const spotifySync = await syncAfterMutation();
    res.json({
      queue: getCombinedQueue().map(serializeQueueItem),
      spotifySync,
      sync: partyState.sync
    });
  })
);

router.post(
  '/admin/playback/start',
  requireAdmin,
  requireEasyJamEnabled,
  asyncHandler(async (_req, res) => {
    await resumeEasyJamPlayback();
    res.json({ ok: true });
  })
);

router.post('/admin/playback/pause', requireAdmin, requireEasyJamEnabled, asyncHandler(async (_req, res) => {
  await pauseSpotifyPlayback();
  res.json({ ok: true });
}));

router.post('/admin/playback/skip', requireAdmin, requireEasyJamEnabled, asyncHandler(async (req, res) => {
  await skipSpotifyTrack(req.body?.direction);
  res.json({ ok: true });
}));

router.post('/admin/playback/seek', requireAdmin, requireEasyJamEnabled, asyncHandler(async (req, res) => {
  await seekSpotifyPlayback(req.body?.positionMs);
  res.json({ ok: true });
}));

router.post(
  '/admin/sync',
  requireAdmin,
  requireEasyJamEnabled,
  asyncHandler(async (_req, res) => {
    cancelScheduledSpotifySync();
    res.json({
      spotifySync: await syncSpotifyPlaylist({
        verifyPlaylist: true,
        manualHostPlaylistSync: true
      }),
      sync: partyState.sync
    });
  })
);

router.post(
  '/admin/host-playlist',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const playlistId = parseSpotifyPlaylistId(req.body.url ?? req.body.playlistId);
    if (!playlistId) {
      const error = new Error('A Spotify playlist URL, URI, or ID is required');
      error.status = 400;
      throw error;
    }

    partyState.sync.playbackControlSuspended = true;
    try {
      const playlist = await getPlaylist(playlistId);
      setHostPlaylist(playlist);
      await saveSpotifyPlaylistId(playlist.id);
      await saveHostPlaylistState();
      const currentPlayback = await getCurrentPlaybackAfterReconnect();
      updatePlaybackCache(currentPlayback);
      const shouldProtectCurrentPlayback = Boolean(currentPlayback?.isPlaying);
      if (shouldProtectCurrentPlayback) {
        partyState.sync.returnToEasyJamPending = true;
        protectCurrentPlayback(currentPlayback);
      }
      const spotifySync = await syncAfterMutation({
        restartIfPaused: true,
        deferToCurrentTrack: true,
        preserveExternalPlayback: true,
        suppressPlaybackStart: shouldProtectCurrentPlayback
      }, { immediate: true });

      res.json({
        host: hostStatus(),
        spotifySync,
        sync: partyState.sync
      });
    } finally {
      partyState.sync.playbackControlSuspended = false;
    }
  })
);

router.post(
  '/playlists/resolve',
  requireInvite,
  asyncHandler(async (req, res) => {
    const playlistId = parseSpotifyPlaylistId(req.body.url ?? req.body.playlistId);
    if (!playlistId) {
      const error = new Error('A Spotify playlist URL, URI, or ID is required');
      error.status = 400;
      throw error;
    }

    const playlist = await getPlaylist(playlistId);
    res.json({
      playlist: {
        id: playlist.id,
        name: playlist.name,
        owner: playlist.owner?.display_name ?? playlist.owner?.id ?? '',
        image: playlist.images?.[0]?.url ?? null,
        url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`
      }
    });
  })
);

router.get(
  '/playlists/:playlistId/tracks',
  requireInviteOrAdmin,
  asyncHandler(async (req, res) => {
    const tracks = await getPlaylistTracks(
      req.params.playlistId,
      req.query.offset,
      req.query.limit,
      req.query.refresh === 'true'
    );
    res.json(tracks);
  })
);

router.post(
  '/admin/pinned-playlists',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const playlistId = parseSpotifyPlaylistId(req.body.url ?? req.body.playlistId);
    if (!playlistId) {
      const error = new Error('A Spotify playlist URL, URI, or ID is required');
      error.status = 400;
      throw error;
    }

    const playlist = await getPlaylist(playlistId);
    const pinnedPlaylist = addPinnedPlaylist(playlist);
    await savePinnedPlaylists();
    res.status(201).json({ playlist: pinnedPlaylist });
  })
);

router.post('/admin/pinned-playlists/refresh', requireAdmin, asyncHandler(async (_req, res) => {
  const result = await refreshPinnedPlaylists();
  if (result.changed) await savePinnedPlaylists();
  res.json({ ...result, pinnedPlaylists: partyState.pinnedPlaylists });
}));

router.delete('/admin/pinned-playlists/:playlistId', requireAdmin, asyncHandler(async (req, res) => {
  removePinnedPlaylist(req.params.playlistId);
  await savePinnedPlaylists();
  res.json({ pinnedPlaylists: partyState.pinnedPlaylists });
}));

router.post('/admin/pinned-playlists/:playlistId/fallback', requireAdmin, asyncHandler(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') {
    const error = new Error('Fallback setting must be a boolean');
    error.status = 400;
    throw error;
  }

  const playlist = setPinnedPlaylistFallbackEnabled(
    req.params.playlistId,
    req.body.enabled
  );
  if (!playlist) {
    const error = new Error('Pinned playlist not found');
    error.status = 404;
    throw error;
  }

  await savePinnedPlaylists();
  res.json({ playlist, pinnedPlaylists: partyState.pinnedPlaylists });
}));

router.post('/admin/pinned-playlists/:playlistId/visibility', requireAdmin, asyncHandler(async (req, res) => {
  if (typeof req.body?.visibleToGuests !== 'boolean') {
    const error = new Error('Guest visibility setting must be a boolean');
    error.status = 400;
    throw error;
  }

  const playlist = setPinnedPlaylistVisibleToGuests(
    req.params.playlistId,
    req.body.visibleToGuests
  );
  if (!playlist) {
    const error = new Error('Pinned playlist not found');
    error.status = 404;
    throw error;
  }

  await savePinnedPlaylists();
  res.json({ playlist, pinnedPlaylists: partyState.pinnedPlaylists });
}));

export function errorHandler(error, _req, res, _next) {
  const status = error.status ?? 500;
  if (error instanceof SpotifyError) {
    console.warn(
      `EasyJam Spotify error: HTTP ${status} ${error.details?.method ?? ''} ${
        error.details?.path ?? ''
      } ${error.message}`.trim()
    );
  }
  res.status(status).json({
    error: {
      message: error.message ?? 'Unexpected server error',
      status,
      code: error.code ?? null,
      details: error.details ?? null
    }
  });
}
