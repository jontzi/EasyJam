import crypto from 'node:crypto';
import { config } from './config.js';

export const partyState = {
  host: {
    tokens: null,
    user: null,
    playlistId: config.spotifyPlaylistId,
    playlistUrl: config.spotifyPlaylistId
      ? `https://open.spotify.com/playlist/${config.spotifyPlaylistId}`
      : null,
    playlistOwnerId: null,
    playlistOwnerName: null,
    playlistPublic: null,
    playlistCollaborative: null,
    playbackDevice: null,
    adminToken: null,
    oauthState: null
  },
  guests: new Map(),
  guestOrder: [],
  bannedGuests: new Map(),
  queueMode: 'roundRobin',
  manualOrder: null,
  pinnedPlaylists: [],
  randomFallback: {
    enabled: false
  },
  invite: {
    token: crypto.randomBytes(16).toString('hex'),
    jamId: crypto.randomUUID(),
    pinHash: '',
    pinEnabled: false,
    guestsCanInvite: true,
    playlistLinksEnabled: true,
    sessions: new Set()
  },
  playback: {
    lastTrackId: null,
    currentItemId: null,
    optimisticCompletion: null,
    history: []
  },
  leaderboardResetAt: null,
  sync: {
    inFlight: false,
    lastSyncedAt: null,
    lastError: null,
    autoStarted: false,
    lastSource: null,
    lastPlaylistUris: [],
    lastPlaylistSnapshotId: null,
    syncPending: false,
    scheduledSyncAt: null,
    fallbackTracks: [],
    returnToEasyJamPending: false,
    pendingHandoff: null,
    playlistRefreshPending: false,
    protectedPlaybackUri: null,
    noActivePlaybackSince: null,
    playbackControlSuspended: false,
    // A host pause in Spotify must take precedence over automatic handoffs.
    manualPause: false
  }
};

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

export function setInviteSettings({ pin, pinEnabled, guestsCanInvite, playlistLinksEnabled }) {
  if (pin !== undefined) {
    const normalized = String(pin ?? '').trim().slice(0, 12);
    if (normalized) {
      partyState.invite.pinHash = hashPin(normalized);
      partyState.invite.pinEnabled = true;
      partyState.invite.sessions.clear();
    }
  }

  if (pinEnabled !== undefined) {
    partyState.invite.pinEnabled = Boolean(pinEnabled) && Boolean(partyState.invite.pinHash);
    partyState.invite.sessions.clear();
  }

  if (guestsCanInvite !== undefined) {
    partyState.invite.guestsCanInvite = Boolean(guestsCanInvite);
  }

  if (playlistLinksEnabled !== undefined) {
    partyState.invite.playlistLinksEnabled = Boolean(playlistLinksEnabled);
  }

  return partyState.invite;
}

export function rotateInviteToken() {
  partyState.invite.token = crypto.randomBytes(16).toString('hex');
  partyState.invite.jamId = crypto.randomUUID();
  partyState.invite.sessions.clear();
  return partyState.invite;
}

export function verifyInvite(token, pin) {
  if (String(token ?? '') !== partyState.invite.token) {
    const error = new Error('Invalid invite link');
    error.status = 401;
    throw error;
  }

  if (
    partyState.invite.pinEnabled &&
    partyState.invite.pinHash &&
    hashPin(String(pin ?? '')) !== partyState.invite.pinHash
  ) {
    const error = new Error('Invalid invite PIN');
    error.status = 401;
    throw error;
  }

  const accessToken = crypto.randomBytes(24).toString('hex');
  partyState.invite.sessions.add(accessToken);
  return accessToken;
}

export function hasInviteAccess(token, accessToken) {
  if (String(token ?? '') !== partyState.invite.token) return false;
  if (!partyState.invite.pinEnabled || !partyState.invite.pinHash) return true;
  return partyState.invite.sessions.has(String(accessToken ?? ''));
}

export function getGuestStats() {
  const now = Date.now();
  const activeWindowMs = 90 * 1000;
  const guests = [...partyState.guests.values()];

  return {
    total: guests.length,
    active: guests.filter((guest) => {
      const lastActiveAt = Date.parse(guest.lastActiveAt);
      return Number.isFinite(lastActiveAt) && now - lastActiveAt <= activeWindowMs;
    }).length
  };
}

function isGuestActive(guest, now = Date.now()) {
  const lastActiveAt = Date.parse(guest.lastActiveAt);
  return Number.isFinite(lastActiveAt) && now - lastActiveAt <= 90 * 1000;
}

export function getGuests() {
  const now = Date.now();
  return partyState.guestOrder
    .map((guestId) => partyState.guests.get(guestId))
    .filter(Boolean)
    .map((guest) => ({
      id: guest.id,
      name: guest.name,
      createdAt: guest.createdAt,
      lastActiveAt: guest.lastActiveAt,
      active: isGuestActive(guest, now),
      queueCount: guest.queue.filter((item) => !isOptimisticallyCompleted(item)).length
    }));
}

export function getRequestStats() {
  const visibleQueue = getVisibleQueue();
  return {
    total: partyState.playback.history.length + visibleQueue.length,
    waiting: visibleQueue.length
  };
}

export function getRequesterStats() {
  const counts = new Map();
  const leaderboardResetAt = Date.parse(partyState.leaderboardResetAt || '');
  const items = [
    ...partyState.playback.history,
    ...getVisibleQueue().filter((item) => item.id !== partyState.playback.currentItemId)
  ];

  for (const item of items) {
    if (!item?.guestId || item.guestId === 'spotify') continue;
    const requestedAt = Date.parse(item.requestedAt || item.addedAt || '');
    if (Number.isFinite(leaderboardResetAt) && requestedAt < leaderboardResetAt) continue;
    const guest = partyState.guests.get(item.guestId);
    const name = item.guestName || guest?.name || `Guest ${item.guestId.slice(0, 6)}`;
    const leaderboardKey = name.trim().toLocaleLowerCase('fi-FI');
    const existing = counts.get(leaderboardKey) || {
      id: `name:${leaderboardKey}`,
      name,
      count: 0
    };
    existing.count += 1;
    counts.set(leaderboardKey, existing);
  }

  return [...counts.values()].sort((left, right) =>
    right.count - left.count || left.name.localeCompare(right.name)
  );
}

export function resetRequesterStats() {
  partyState.leaderboardResetAt = new Date().toISOString();
  return partyState.leaderboardResetAt;
}

export function serializeInvite(req = null, includeSecret = false) {
  const origin = req ? `${req.protocol}://${req.get('host')}` : '';
  const inviteUrl = origin
    ? `${origin}/join/${partyState.invite.token}`
    : `/join/${partyState.invite.token}`;

  return {
    pinRequired: Boolean(partyState.invite.pinEnabled && partyState.invite.pinHash),
    pinEnabled: Boolean(partyState.invite.pinEnabled && partyState.invite.pinHash),
    pinConfigured: Boolean(partyState.invite.pinHash),
    guestsCanInvite: partyState.invite.guestsCanInvite,
    playlistLinksEnabled: partyState.invite.playlistLinksEnabled,
    ...(includeSecret
      ? {
          token: partyState.invite.token,
          inviteUrl
        }
      : {})
  };
}

export function getDisplayInviteUrl(req) {
  if (!req || !partyState.invite.guestsCanInvite) return null;
  return `${req.protocol}://${req.get('host')}/join/${partyState.invite.token}`;
}

export function hydratePersistentState({
  invite,
  pinnedPlaylists,
  randomFallback,
  leaderboardResetAt,
  livePartyState,
  playbackHistory
} = {}) {
  if (invite?.token) partyState.invite.token = invite.token;
  if (invite?.jamId) partyState.invite.jamId = invite.jamId;
  if (invite?.pinHash) partyState.invite.pinHash = invite.pinHash;
  if (typeof invite?.pinEnabled === 'boolean') {
    partyState.invite.pinEnabled = invite.pinEnabled && Boolean(partyState.invite.pinHash);
  } else {
    partyState.invite.pinEnabled = Boolean(partyState.invite.pinHash);
  }
  if (typeof invite?.guestsCanInvite === 'boolean') {
    partyState.invite.guestsCanInvite = invite.guestsCanInvite;
  }
  if (typeof invite?.playlistLinksEnabled === 'boolean') {
    partyState.invite.playlistLinksEnabled = invite.playlistLinksEnabled;
  }
  if (Array.isArray(pinnedPlaylists)) {
    partyState.pinnedPlaylists = pinnedPlaylists;
  }
  if (typeof randomFallback?.enabled === 'boolean') {
    partyState.randomFallback.enabled = randomFallback.enabled;
  }
  if (Number.isFinite(Date.parse(leaderboardResetAt || ''))) {
    partyState.leaderboardResetAt = leaderboardResetAt;
  }
  hydrateLivePartyState(livePartyState);
  if (Array.isArray(playbackHistory)) {
    partyState.playback.history = playbackHistory;
    partyState.playback.lastTrackId = playbackHistory[0]?.track?.id ?? null;
  }
}

function hydrateLivePartyState(livePartyState) {
  if (!livePartyState || typeof livePartyState !== 'object') return;

  const restoredGuests = new Map();
  for (const candidate of Array.isArray(livePartyState.guests) ? livePartyState.guests : []) {
    const id = typeof candidate?.id === 'string' ? candidate.id : '';
    if (!id || restoredGuests.has(id)) continue;

    const queue = [];
    for (const candidateItem of Array.isArray(candidate.queue) ? candidate.queue : []) {
      try {
        const track = normalizeTrack(candidateItem?.track);
        const itemId = typeof candidateItem?.id === 'string' ? candidateItem.id : '';
        if (!itemId) continue;
        queue.push({
          id: itemId,
          track,
          guestId: id,
          guestName:
            typeof candidateItem.guestName === 'string' ? candidateItem.guestName.slice(0, 40) : null,
          jamId:
            typeof candidateItem.jamId === 'string'
              ? candidateItem.jamId
              : partyState.invite.jamId,
          addedAt: Number.isFinite(Date.parse(candidateItem.addedAt || ''))
            ? candidateItem.addedAt
            : new Date().toISOString()
        });
      } catch {
        // Ignore malformed persisted queue items while restoring the remaining state.
      }
    }

    restoredGuests.set(id, {
      id,
      name: typeof candidate.name === 'string' ? candidate.name.slice(0, 40) : null,
      queue,
      createdAt: Number.isFinite(Date.parse(candidate.createdAt || ''))
        ? candidate.createdAt
        : new Date().toISOString(),
      lastActiveAt: Number.isFinite(Date.parse(candidate.lastActiveAt || ''))
        ? candidate.lastActiveAt
        : new Date(0).toISOString()
    });
  }

  partyState.guests = restoredGuests;
  const restoredOrder = Array.isArray(livePartyState.guestOrder)
    ? livePartyState.guestOrder.filter((id) => restoredGuests.has(id))
    : [];
  partyState.guestOrder = [...new Set([...restoredOrder, ...restoredGuests.keys()])];

  const restoredBans = new Map();
  for (const candidate of Array.isArray(livePartyState.bannedGuests)
    ? livePartyState.bannedGuests
    : []) {
    const id = typeof candidate?.id === 'string' ? candidate.id : '';
    if (!id || restoredBans.has(id)) continue;
    restoredBans.set(id, {
      id,
      name: typeof candidate.name === 'string' ? candidate.name.slice(0, 40) : null,
      bannedAt: Number.isFinite(Date.parse(candidate.bannedAt || ''))
        ? candidate.bannedAt
        : new Date().toISOString()
    });
  }
  partyState.bannedGuests = restoredBans;
  partyState.queueMode = livePartyState.queueMode === 'fifo' ? 'fifo' : 'roundRobin';

  const queueItemIds = new Set(
    [...restoredGuests.values()].flatMap((guest) => guest.queue.map((item) => item.id))
  );
  partyState.manualOrder = Array.isArray(livePartyState.manualOrder)
    ? livePartyState.manualOrder.filter((id) => queueItemIds.has(id))
    : null;
  partyState.playback.currentItemId = queueItemIds.has(livePartyState.currentItemId)
    ? livePartyState.currentItemId
    : null;
}

export function setPersistedHostPlaylistId(playlistId) {
  const normalizedId = String(playlistId ?? '').trim();
  if (!normalizedId) return;

  partyState.host.playlistId = normalizedId;
  partyState.host.playlistUrl = `https://open.spotify.com/playlist/${normalizedId}`;
}

export function ensureGuest(guestId) {
  if (!guestId || typeof guestId !== 'string') {
    const error = new Error('guestId is required');
    error.status = 400;
    throw error;
  }

  if (partyState.bannedGuests.has(guestId)) {
    const error = new Error('You have been banned from this party');
    error.status = 403;
    error.code = 'GUEST_BANNED';
    throw error;
  }

  if (!partyState.guests.has(guestId)) {
    partyState.guests.set(guestId, {
      id: guestId,
      name: null,
      queue: [],
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString()
    });
    partyState.guestOrder.push(guestId);
  }

  const guest = partyState.guests.get(guestId);
  guest.lastActiveAt = new Date().toISOString();
  return guest;
}

export function removeGuest(guestId) {
  const guest = partyState.guests.get(guestId);
  if (!guest) {
    const error = new Error('Guest not found');
    error.status = 404;
    throw error;
  }

  const queueItemIds = new Set(guest.queue.map((item) => item.id));
  partyState.guests.delete(guestId);
  partyState.guestOrder = partyState.guestOrder.filter((id) => id !== guestId);

  if (partyState.manualOrder) {
    partyState.manualOrder = partyState.manualOrder.filter((id) => !queueItemIds.has(id));
  }
  if (queueItemIds.has(partyState.playback.currentItemId)) {
    partyState.playback.currentItemId = null;
  }

  return guest;
}

export function banGuest(guestId) {
  const guest = removeGuest(guestId);
  partyState.bannedGuests.set(guestId, {
    id: guest.id,
    name: guest.name,
    bannedAt: new Date().toISOString()
  });
  return guest;
}

export function getBannedGuests() {
  return [...partyState.bannedGuests.values()];
}

export function unbanGuest(guestId) {
  if (!partyState.bannedGuests.delete(guestId)) {
    const error = new Error('Banned guest not found');
    error.status = 404;
    throw error;
  }
}

export function removeAllGuests() {
  const guestIds = [...partyState.guests.keys()];
  for (const guestId of guestIds) removeGuest(guestId);
  return guestIds.length;
}

export function setGuestName(guestId, name) {
  const guest = ensureGuest(guestId);
  const normalized = String(name ?? '').trim().slice(0, 40);
  guest.name = normalized || null;
  return guest;
}

export function normalizeTrack(track) {
  if (!track || typeof track !== 'object') {
    const error = new Error('track is required');
    error.status = 400;
    throw error;
  }

  const uri = track.uri;
  const id = track.id || uri?.split(':').pop();

  if (!id || !uri || !uri.startsWith('spotify:track:')) {
    const error = new Error('Only Spotify track URIs can be queued');
    error.status = 400;
    throw error;
  }

  return {
    id,
    uri,
    name: String(track.name ?? 'Unknown track'),
    artists: Array.isArray(track.artists)
      ? track.artists.map((artist) =>
          typeof artist === 'string' ? artist : artist?.name
        ).filter(Boolean)
      : [],
    album: track.album?.name ?? track.album ?? '',
    image:
      track.image ??
      track.album?.images?.[0]?.url ??
      track.album?.images?.[1]?.url ??
      null,
    durationMs: Number(track.durationMs ?? track.duration_ms ?? 0),
    explicit: Boolean(track.explicit)
  };
}

export function addTrackForGuest(guestId, track, guestName = null) {
  const guest = ensureGuest(guestId);
  if (guestName !== null && guestName !== undefined) {
    setGuestName(guestId, guestName);
  }

  const normalizedTrack = normalizeTrack(track);
  const isAlreadyUpcoming = [...partyState.guests.values()].some((queuedGuest) =>
    queuedGuest.queue.some((item) => item.track.uri === normalizedTrack.uri)
  );
  if (isAlreadyUpcoming) {
    const error = new Error('This song is already in the upcoming queue');
    error.status = 409;
    error.code = 'DUPLICATE_UPCOMING_TRACK';
    throw error;
  }

  const item = {
    id: crypto.randomUUID(),
    track: normalizedTrack,
    guestId,
    guestName: guest.name,
    jamId: partyState.invite.jamId,
    addedAt: new Date().toISOString()
  };

  guest.queue.push(item);
  return item;
}

export function removeItem(itemId, guestId = null) {
  let removed = null;

  for (const guest of partyState.guests.values()) {
    const index = guest.queue.findIndex((item) => item.id === itemId);
    if (index === -1) continue;

    if (guestId && guest.id !== guestId) {
      const error = new Error('Cannot remove another guest queue item');
      error.status = 403;
      throw error;
    }

    removed = guest.queue.splice(index, 1)[0];
    break;
  }

  if (!removed) {
    const error = new Error('Queue item not found');
    error.status = 404;
    throw error;
  }

  if (partyState.manualOrder) {
    partyState.manualOrder = partyState.manualOrder.filter((id) => id !== itemId);
  }

  if (partyState.playback.currentItemId === itemId) {
    partyState.playback.currentItemId = null;
  }
  if (partyState.playback.optimisticCompletion?.itemId === itemId) {
    partyState.playback.optimisticCompletion = null;
  }

  return removed;
}

export function buildRoundRobinQueue() {
  const activeGuests = partyState.guestOrder
    .map((guestId) => partyState.guests.get(guestId))
    .filter((guest) => guest?.queue.length);

  const maxLength = activeGuests.reduce(
    (max, guest) => Math.max(max, guest.queue.length),
    0
  );
  const merged = [];

  for (let index = 0; index < maxLength; index += 1) {
    for (const guest of activeGuests) {
      if (guest.queue[index]) merged.push(guest.queue[index]);
    }
  }

  return merged;
}

export function buildFifoQueue() {
  return [...partyState.guests.values()]
    .flatMap((guest) => guest.queue)
    .sort((first, second) => {
      const timeDifference = Date.parse(first.addedAt) - Date.parse(second.addedAt);
      return timeDifference || first.id.localeCompare(second.id);
    });
}

function getQueueByMode() {
  return partyState.queueMode === 'fifo' ? buildFifoQueue() : buildRoundRobinQueue();
}

export function getCombinedQueue() {
  const queueByMode = getQueueByMode();
  if (!partyState.manualOrder?.length) return queueByMode;

  const byId = new Map(queueByMode.map((item) => [item.id, item]));
  const manuallyPlaced = partyState.manualOrder
    .map((itemId) => byId.get(itemId))
    .filter(Boolean);
  const manuallyPlacedIds = new Set(manuallyPlaced.map((item) => item.id));

  return [
    ...manuallyPlaced,
    ...queueByMode.filter((item) => !manuallyPlacedIds.has(item.id))
  ];
}

function isOptimisticallyCompleted(item) {
  return item?.id === partyState.playback.optimisticCompletion?.itemId;
}

export function getVisibleQueue() {
  return getCombinedQueue().filter((item) => !isOptimisticallyCompleted(item));
}

export function beginOptimisticCompletion(previousTrackUri, expectedNextUri) {
  if (!previousTrackUri || !expectedNextUri) return false;
  const item = getCombinedQueue().find((candidate) => candidate.track?.uri === previousTrackUri);
  if (!item) return false;

  partyState.playback.optimisticCompletion = {
    itemId: item.id,
    previousTrackUri,
    expectedNextUri,
    createdAt: new Date().toISOString()
  };
  return true;
}

export function setQueueMode(queueMode) {
  if (queueMode !== 'roundRobin' && queueMode !== 'fifo') {
    const error = new Error('queueMode must be roundRobin or fifo');
    error.status = 400;
    throw error;
  }

  // Keep the already visible queue stable. Clearing this snapshot is an explicit
  // admin action, which then applies the selected mode to every current request.
  if (!partyState.manualOrder?.length) {
    partyState.manualOrder = getCombinedQueue().map((item) => item.id);
  }
  partyState.queueMode = queueMode;
  return getCombinedQueue();
}

export function getGuestQueue(guestId) {
  return ensureGuest(guestId).queue;
}

export function setManualOrder(orderedItemIds) {
  if (!Array.isArray(orderedItemIds)) {
    const error = new Error('orderedItemIds must be an array');
    error.status = 400;
    throw error;
  }

  const currentIds = new Set(getQueueByMode().map((item) => item.id));
  partyState.manualOrder = orderedItemIds.filter((itemId) => currentIds.has(itemId));
  return getCombinedQueue();
}

export function resetManualOrder() {
  partyState.manualOrder = null;
  return getCombinedQueue();
}

export function serializeQueueItem(item) {
  const guest = partyState.guests.get(item.guestId);
  return {
    ...item,
    guestLabel: item.guestName || guest?.name || `Guest ${item.guestId.slice(0, 6)}`,
    isCurrent: item.id === partyState.playback.currentItemId
  };
}

export function serializePlaybackItem(item) {
  const guest = partyState.guests.get(item.guestId);
  const guestLabel =
    item.guestName ||
    guest?.name ||
    (item.guestId === 'spotify' ? 'Spotify' : `Guest ${item.guestId.slice(0, 6)}`);

  return {
    ...item,
    guestLabel,
    isCurrent: false
  };
}

export function serializeQueues(guestId = null) {
  const visibleQueue = getVisibleQueue();
  return {
    queue: visibleQueue.map(serializeQueueItem),
    mine: guestId
      ? getGuestQueue(guestId).filter((item) => !isOptimisticallyCompleted(item)).map(serializeQueueItem)
      : [],
    history: partyState.playback.history.map(serializePlaybackItem),
    fallbackTracks: partyState.sync.fallbackTracks.map((track) => ({
      id: `fallback-${track.uri}`,
      track,
      guestId: 'spotify',
      guestName: 'EasyJAM fallback',
      guestLabel: 'EasyJAM fallback',
      addedAt: partyState.sync.lastSyncedAt
    })),
    manualOrderActive: Boolean(partyState.manualOrder?.length),
    queueMode: partyState.queueMode,
    sync: partyState.sync
  };
}

export function recordPlayback(currentPlayback) {
  const track = currentPlayback?.track;
  if (!track?.id) {
    return { changed: false, removedItem: null };
  }
  if (partyState.playback.lastTrackId === track.id) {
    const optimisticCompletion = partyState.playback.optimisticCompletion;
    if (optimisticCompletion && track.uri !== optimisticCompletion.expectedNextUri) {
      partyState.playback.optimisticCompletion = null;
      return { changed: true, removedItem: null, revertedOptimisticCompletion: true };
    }
    return { changed: false, removedItem: null };
  }

  const easyJamContextUri = partyState.host.playlistId
    ? `spotify:playlist:${partyState.host.playlistId}`
    : null;
  const isEasyJamPlayback = Boolean(
    easyJamContextUri && currentPlayback.contextUri === easyJamContextUri
  );
  const optimisticCompletion = partyState.playback.optimisticCompletion;
  let optimisticRemovedItem = null;
  if (optimisticCompletion) {
    const optimisticTransitionConfirmed =
      isEasyJamPlayback && track.uri === optimisticCompletion.expectedNextUri;
    if (optimisticTransitionConfirmed) {
      try {
        optimisticRemovedItem = removeItem(optimisticCompletion.itemId);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    partyState.playback.optimisticCompletion = null;
  }
  const currentQueueItem = isEasyJamPlayback
    ? getCombinedQueue().find((item) => item.track.id === track.id)
    : null;
  const previousItemId = partyState.playback.currentItemId;
  let removedItem = optimisticRemovedItem;

  if (previousItemId && previousItemId !== currentQueueItem?.id) {
    try {
      const previousRemovedItem = removeItem(previousItemId);
      removedItem ??= previousRemovedItem;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  partyState.playback.currentItemId = currentQueueItem?.id ?? null;
  partyState.playback.lastTrackId = track.id;
  const isFallbackTrack =
    isEasyJamPlayback &&
    partyState.sync.fallbackTracks.some((fallbackTrack) => fallbackTrack.uri === track.uri);
  const requesterType = currentQueueItem
    ? 'visitor'
    : isFallbackTrack
      ? 'easyjam_fallback'
      : 'spotify';
  const historyItem = {
    id: crypto.randomUUID(),
    track,
    guestId: currentQueueItem?.guestId ?? 'spotify',
    guestName:
      currentQueueItem?.guestName ??
      (currentQueueItem
        ? partyState.guests.get(currentQueueItem.guestId)?.name ?? null
        : isFallbackTrack
          ? 'EasyJAM fallback'
          : 'Spotify'),
    requesterType,
    jamId: currentQueueItem?.jamId ?? partyState.invite.jamId,
    requestedAt: currentQueueItem?.addedAt ?? new Date().toISOString(),
    addedAt: new Date().toISOString()
  };

  partyState.playback.history = [
    historyItem,
    ...partyState.playback.history
  ].slice(0, 100);

  return {
    changed: true,
    removedItem,
    historyItem,
    currentItemId: partyState.playback.currentItemId
  };
}

export function setHostTokens(tokens) {
  partyState.host.tokens = tokens;
}

export function setHostUser(user) {
  partyState.host.user = user;
}

export function setHostPlaylist(playlist) {
  partyState.host.playlistId = playlist.id;
  partyState.host.playlistUrl =
    playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`;
  partyState.host.playlistOwnerId = playlist.owner?.id ?? null;
  partyState.host.playlistOwnerName =
    playlist.owner?.display_name ?? playlist.owner?.id ?? null;
  partyState.host.playlistPublic =
    typeof playlist.public === 'boolean' ? playlist.public : null;
  partyState.host.playlistCollaborative =
    typeof playlist.collaborative === 'boolean' ? playlist.collaborative : null;
}

export function setAdminToken(token) {
  partyState.host.adminToken = token;
}

export function addPinnedPlaylist(playlist) {
  const item = {
    id: playlist.id,
    name: playlist.name,
    owner: playlist.owner?.display_name ?? playlist.owner?.id ?? '',
    image: playlist.images?.[0]?.url ?? null,
    url: playlist.external_urls?.spotify ?? `https://open.spotify.com/playlist/${playlist.id}`,
    fallbackEnabled: true,
    visibleToGuests: true,
    trackTotal: Math.max(
      Number(playlist.items?.total ?? playlist.tracks?.total) || 0,
      0
    )
  };

  partyState.pinnedPlaylists = [
    item,
    ...partyState.pinnedPlaylists.filter((existing) => existing.id !== item.id)
  ];

  return item;
}

export function removePinnedPlaylist(playlistId) {
  partyState.pinnedPlaylists = partyState.pinnedPlaylists.filter(
    (playlist) => playlist.id !== playlistId
  );
}

export function setPinnedPlaylistFallbackEnabled(playlistId, enabled) {
  const playlist = partyState.pinnedPlaylists.find(
    (item) => item.id === playlistId
  );
  if (!playlist) return null;
  playlist.fallbackEnabled = Boolean(enabled);
  return playlist;
}

export function setPinnedPlaylistVisibleToGuests(playlistId, visibleToGuests) {
  const playlist = partyState.pinnedPlaylists.find(
    (item) => item.id === playlistId
  );
  if (!playlist) return null;
  playlist.visibleToGuests = Boolean(visibleToGuests);
  return playlist;
}

export function setRandomFallbackEnabled(enabled) {
  partyState.randomFallback.enabled = Boolean(enabled);
  return partyState.randomFallback;
}

export function parseSpotifyPlaylistId(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const uriMatch = raw.match(/^spotify:playlist:([A-Za-z0-9]+)$/);
  if (uriMatch) return uriMatch[1];

  const urlMatch = raw.match(/open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];

  const bareIdMatch = raw.match(/^[A-Za-z0-9]{16,}$/);
  return bareIdMatch ? raw : null;
}
