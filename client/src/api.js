const JSON_HEADERS = {
  'Content-Type': 'application/json'
};

const inviteTokenKey = 'easyjam.inviteToken';
const inviteAccessTokenKey = 'easyjam.inviteAccessToken';
const guestIdKey = 'easyjam.guestId';

export function getGuestId() {
  let guestId = localStorage.getItem(guestIdKey);
  if (!guestId) {
    guestId = crypto.randomUUID();
    localStorage.setItem(guestIdKey, guestId);
  }
  return guestId;
}

export function clearGuestId() {
  localStorage.removeItem(guestIdKey);
}

export function getAdminToken() {
  return localStorage.getItem('easyjam.adminToken') || '';
}

export function setAdminToken(token) {
  if (token) localStorage.setItem('easyjam.adminToken', token);
}

export function clearAdminToken() {
  localStorage.removeItem('easyjam.adminToken');
}

export function getInviteToken() {
  return localStorage.getItem(inviteTokenKey) || '';
}

export function setInviteToken(token) {
  if (token) localStorage.setItem(inviteTokenKey, token);
}

export function getInviteAccessToken() {
  return localStorage.getItem(inviteAccessTokenKey) || '';
}

export function setInviteAccessToken(token) {
  if (token) localStorage.setItem(inviteAccessTokenKey, token);
}

export function clearInviteAccess() {
  localStorage.removeItem(inviteAccessTokenKey);
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? JSON_HEADERS : {}),
      ...(options.admin ? { 'x-admin-token': getAdminToken() } : {}),
      ...(getInviteToken() ? { 'x-invite-token': getInviteToken() } : {}),
      ...(getInviteAccessToken()
        ? { 'x-invite-access-token': getInviteAccessToken() }
        : {}),
      ...(options.headers ?? {})
    },
    body:
      options.body && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body
  });

  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Request failed');
    error.status = response.status;
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

async function requestBlob(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.admin ? { 'x-admin-token': getAdminToken() } : {}),
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    const payload = await response.json();
    const error = new Error(payload?.error?.message || 'Request failed');
    error.status = response.status;
    error.details = payload?.error?.details;
    throw error;
  }

  return {
    blob: await response.blob(),
    filename:
      response.headers
        .get('content-disposition')
        ?.match(/filename="([^"]+)"/)?.[1] ?? 'easyjam-played-log.csv'
  };
}

export const api = {
  session: () => request('/api/session'),
  inviteStatus: (token) =>
    request(`/api/invite/status?token=${encodeURIComponent(token || '')}`),
  verifyInvite: (token, pin) =>
    request('/api/invite/verify', {
      method: 'POST',
      body: { token, pin }
    }),
  adminStatus: () => request('/api/admin/status', { admin: true }),
  current: () => request('/api/player/current'),
  search: (query) =>
    request(`/api/search?query=${encodeURIComponent(query)}&limit=12`),
  queue: (guestId) => request(`/api/queue?guestId=${encodeURIComponent(guestId)}`),
  setGuestName: (guestId, name) =>
    request(`/api/guests/${encodeURIComponent(guestId)}/name`, {
      method: 'POST',
      body: { name }
    }),
  guestPlaylists: (guestId) =>
    request(`/api/guests/${encodeURIComponent(guestId)}/playlists`),
  saveGuestPlaylists: (guestId, playlists) =>
    request(`/api/guests/${encodeURIComponent(guestId)}/playlists`, {
      method: 'PUT',
      body: { playlists }
    }),
  addTrack: (guestId, track, guestName) =>
    request('/api/queue/items', {
      method: 'POST',
      body: { guestId, track, guestName }
    }),
  removeMine: (guestId, itemId) =>
    request(
      `/api/queue/items/${itemId}?guestId=${encodeURIComponent(guestId)}`,
      { method: 'DELETE' }
    ),
  removeAny: (itemId) =>
    request(`/api/admin/queue/items/${itemId}`, {
      method: 'DELETE',
      admin: true
    }),
  removeGuest: (guestId) =>
    request(`/api/admin/guests/${encodeURIComponent(guestId)}`, {
      method: 'DELETE',
      admin: true
    }),
  removeAllGuests: () =>
    request('/api/admin/guests', {
      method: 'DELETE',
      admin: true
    }),
  banGuest: (guestId) =>
    request(`/api/admin/guests/${encodeURIComponent(guestId)}/ban`, {
      method: 'POST',
      admin: true
    }),
  unbanGuest: (guestId) =>
    request(`/api/admin/banned-guests/${encodeURIComponent(guestId)}`, {
      method: 'DELETE',
      admin: true
    }),
  reorder: (orderedItemIds) =>
    request('/api/admin/queue/reorder', {
      method: 'POST',
      admin: true,
      body: { orderedItemIds }
    }),
  resetOrder: () =>
    request('/api/admin/queue/reset-order', {
      method: 'POST',
      admin: true
    }),
  setQueueMode: (queueMode) =>
    request('/api/admin/queue/mode', {
      method: 'POST',
      admin: true,
      body: { queueMode }
    }),
  resetLeaderboard: () =>
    request('/api/admin/leaderboard/reset', {
      method: 'POST',
      admin: true
    }),
  sync: () =>
    request('/api/admin/sync', {
      method: 'POST',
      admin: true
    }),
  setRandomFallback: (enabled) =>
    request('/api/admin/random-fallback', {
      method: 'POST',
      admin: true,
      body: { enabled }
    }),
  setAutoPlayback: (enabled) =>
    request('/api/admin/auto-playback', {
      method: 'POST',
      admin: true,
      body: { enabled }
    }),
  playbackDevices: () => request('/api/admin/playback/devices', { admin: true }),
  setPlaybackDevice: (deviceId) =>
    request('/api/admin/playback/device', {
      method: 'POST',
      admin: true,
      body: { deviceId }
    }),
  setEasyJamEnabled: (enabled, deviceId = null) =>
    request('/api/admin/easyjam-enabled', {
      method: 'POST',
      admin: true,
      body: { enabled, ...(deviceId ? { deviceId } : {}) }
    }),
  setHandoffLead: (handoffLeadMs) =>
    request('/api/admin/handoff-lead', {
      method: 'POST',
      admin: true,
      body: { handoffLeadMs }
    }),
  saveInviteSettings: (settings) =>
    request('/api/admin/invite', {
      method: 'POST',
      admin: true,
      body: settings
    }),
  rotateInvite: () =>
    request('/api/admin/invite/rotate', {
      method: 'POST',
      admin: true
    }),
  setHostPlaylist: (url) =>
    request('/api/admin/host-playlist', {
      method: 'POST',
      admin: true,
      body: { url }
    }),
  startPlayback: () =>
    request('/api/admin/playback/start', {
      method: 'POST',
      admin: true
    }),
  pausePlayback: () =>
    request('/api/admin/playback/pause', { method: 'POST', admin: true }),
  skipPlayback: (direction = 'next') =>
    request('/api/admin/playback/skip', {
      method: 'POST',
      admin: true,
      body: { direction }
    }),
  seekPlayback: (positionMs) =>
    request('/api/admin/playback/seek', {
      method: 'POST',
      admin: true,
      body: { positionMs }
    }),
  setPlaybackControlMode: (mode) =>
    request('/api/admin/playback-control-mode', {
      method: 'POST',
      admin: true,
      body: { mode }
    }),
  playbackHistory: () =>
    request('/api/admin/playback/history?limit=100', {
      admin: true
    }),
  spotifyRequestLog: () => request('/api/admin/spotify/request-log', { admin: true }),
  exportSpotifyRequestLog: () =>
    requestBlob('/api/admin/spotify/request-log/export', { admin: true }),
  clearSpotifyRequestLog: () =>
    request('/api/admin/spotify/request-log', {
      method: 'DELETE',
      admin: true
    }),
  exportPlaybackHistory: ({ from, to } = {}) => {
    const query = new URLSearchParams();
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    const suffix = query.size ? `?${query}` : '';
    return requestBlob(`/api/admin/playback/history/export${suffix}`, {
      admin: true
    });
  },
  unlockAdmin: (accessKey) =>
    request('/api/admin/access', {
      method: 'POST',
      body: { accessKey }
    }),
  adminAccessStatus: () => request('/api/admin/access/status'),
  saveSpotifySetup: (setup) =>
    request('/api/setup/spotify', {
      method: 'POST',
      body: setup
    }),
  resolvePlaylist: (url) =>
    request('/api/playlists/resolve', {
      method: 'POST',
      body: { url }
    }),
  playlistTracks: (playlistId, offset = 0, admin = false, refresh = false) =>
    request(
      `/api/playlists/${playlistId}/tracks?offset=${offset}&limit=30${refresh ? '&refresh=true' : ''}`,
      { admin }
    ),
  pinPlaylist: (url) =>
    request('/api/admin/pinned-playlists', {
      method: 'POST',
      admin: true,
      body: { url }
    }),
  refreshPinnedPlaylists: () =>
    request('/api/admin/pinned-playlists/refresh', {
      method: 'POST',
      admin: true
    }),
  removePinned: (playlistId) =>
    request(`/api/admin/pinned-playlists/${playlistId}`, {
      method: 'DELETE',
      admin: true
    }),
  setPinnedFallback: (playlistId, enabled) =>
    request(`/api/admin/pinned-playlists/${playlistId}/fallback`, {
      method: 'POST',
      admin: true,
      body: { enabled }
    }),
  setPinnedGuestVisibility: (playlistId, visibleToGuests) =>
    request(`/api/admin/pinned-playlists/${playlistId}/visibility`, {
      method: 'POST',
      admin: true,
      body: { visibleToGuests }
    }),
  recommendations: (guestId) =>
    request(`/api/recommendations?guestId=${encodeURIComponent(guestId)}&limit=20`)
};
