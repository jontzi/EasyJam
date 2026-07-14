import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import QRCode from 'qrcode';
import { createPortal } from 'react-dom';
import {
  GripVertical,
  Globe2,
  Home,
  ListMusic,
  LogOut,
  Lock,
  Download,
  FileUp,
  Play,
  Pencil,
  Plus,
  Check,
  LoaderCircle,
  RefreshCcw,
  Radio,
  Search,
  Settings,
  Trash2,
  User,
  Users,
  UsersRound,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  api,
  clearGuestId,
  clearAdminToken,
  clearInviteAccess,
  getAdminToken,
  getGuestId,
  getInviteAccessToken,
  getInviteToken,
  setAdminToken,
  setInviteAccessToken,
  setInviteToken
} from './api.js';
import i18n from './i18n.js';

const savedPlaylistsKey = 'easyjam.savedPlaylists';
const guestNameKey = 'easyjam.guestName';

function useDebouncedValue(value, delay = 300) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timeout);
  }, [value, delay]);

  return debouncedValue;
}

function formatDuration(durationMs) {
  if (!durationMs) return '';
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

function useLanguage() {
  const { t } = useTranslation();

  function toggleLanguage() {
    const next = i18n.language === 'fi' ? 'en' : 'fi';
    localStorage.setItem('easyjam.language', next);
    i18n.changeLanguage(next);
  }

  return { t, toggleLanguage };
}

function usePolling(callback, delay) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!delay) return undefined;

    callbackRef.current();
    const interval = setInterval(() => {
      callbackRef.current();
    }, delay);

    return () => clearInterval(interval);
  }, [delay]);
}

function useSingleFlightCallback(callback) {
  const inFlight = useRef(false);

  return useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await callback();
    } finally {
      inFlight.current = false;
    }
  }, [callback]);
}

function Toast({ message, tone = 'success', onDone }) {
  useEffect(() => {
    if (!message) return undefined;
    const timeout = window.setTimeout(onDone, 2200);
    return () => window.clearTimeout(timeout);
  }, [message, onDone]);

  if (!message) return null;

  return (
    <div
      className={`toast toast-${tone}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      {message}
    </div>
  );
}

function Feedback({ message, tone = 'empty', className = '' }) {
  if (!message) return null;

  const isError = tone === 'error';
  const isSuccess = tone === 'success';
  const classes = [
    tone === 'error' ? 'inline-error' : tone === 'success' ? 'success-state' : 'empty-state',
    className
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      role={isError ? 'alert' : isSuccess ? 'status' : undefined}
      aria-live={isError ? 'assertive' : isSuccess ? 'polite' : undefined}
    >
      {message}
    </div>
  );
}

function BrandMark({ compact = false }) {
  return (
    <svg
      className={compact ? 'brand-logo compact' : 'brand-logo'}
      viewBox="0 0 196 48"
      role="img"
      aria-label="EasyJAM"
    >
      <text className="brand-logo-easy" x="0" y="35">Easy</text>
      <text className="brand-logo-jam" x="70" y="35">JAM</text>
      <g className="brand-logo-bars" transform="translate(156 12)">
        <rect x="0" y="8" width="4" height="12" rx="2" />
        <rect x="8" y="2" width="4" height="24" rx="2" />
        <rect x="16" y="6" width="4" height="16" rx="2" />
      </g>
    </svg>
  );
}

function SessionStatus({ session }) {
  const { t } = useTranslation();
  const connected = Boolean(session?.host?.authenticated);

  return (
    <div className={connected ? 'session-status is-live' : 'session-status'}>
      <span aria-hidden="true" />
      {connected ? t('sessionLive') : t('sessionWaiting')}
    </div>
  );
}

function MiniPlayer({ current }) {
  const { t } = useTranslation();
  const track = current?.track;

  return (
    <section className="mini-player" aria-label={t('nowPlaying')}>
      {track ? (
        <>
          <img src={track.image || '/placeholder-album.svg'} alt="" />
          <div>
            <span>{t('nowPlaying')}</span>
            <strong>{track.name}</strong>
          </div>
        </>
      ) : (
        <>
          <div className="mini-vinyl" aria-hidden="true" />
          <div>
            <span>{t('nowPlaying')}</span>
            <strong>{t('noTrack')}</strong>
          </div>
        </>
      )}
    </section>
  );
}

function InviteQrPanel({ inviteUrl, canInvite = true, onCopied }) {
  const { t } = useTranslation();
  const [qrDataUrl, setQrDataUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!inviteUrl || !canInvite) {
      setQrDataUrl('');
      return undefined;
    }

    QRCode.toDataURL(inviteUrl, {
      margin: 1,
      width: 220,
      color: {
        dark: '#101311',
        light: '#f4f7f3'
      }
    }).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl);
    });

    return () => {
      cancelled = true;
    };
  }, [inviteUrl, canInvite]);

  if (!canInvite) {
    return <Feedback message={t('guestInvitesDisabled')} />;
  }

  if (!inviteUrl) return null;

  async function copyInvite() {
    await navigator.clipboard?.writeText(inviteUrl);
    onCopied?.();
  }

  return (
    <div className="invite-card">
      {qrDataUrl ? <img className="invite-qr" src={qrDataUrl} alt="" /> : null}
      <div className="invite-copy">
        <div className="muted">{t('inviteHelp')}</div>
        <a className="small-link invite-url" href={inviteUrl}>
          {inviteUrl}
        </a>
        <button type="button" onClick={copyInvite}>
          {t('copyInviteLink')}
        </button>
      </div>
    </div>
  );
}

function InviteGate({ inviteToken, onVerified, showHostCta = true }) {
  const { t, toggleLanguage } = useLanguage();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  async function verify(event) {
    event.preventDefault();
    setError('');

    try {
      const result = await api.verifyInvite(inviteToken, pin);
      setInviteToken(inviteToken);
      setInviteAccessToken(result.accessToken);
      onVerified(result.invite);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="app-shell">
      <header className="welcome-header">
        <div>
          <BrandMark />
          <div className="welcome-copy">{t('tagline')}</div>
        </div>
        <button className="icon-button" type="button" onClick={toggleLanguage}>
          <Globe2 size={17} aria-hidden="true" />
          <span>{t('language')}</span>
        </button>
      </header>

      <section className="panel login-panel join-panel">
        <h1 className="panel-title">{t('joinAJam')}</h1>
        <Feedback message={inviteToken ? t('invitePinHelp') : t('inviteLinkMissing')} />
        {inviteToken ? (
          <form className="setup-form" onSubmit={verify}>
            <label>
              <span>{t('invitePin')}</span>
              <input
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </label>
            <Feedback message={error} tone="error" />
            <button type="submit">
              {t('joinParty')}
              <span aria-hidden="true">{'>'}</span>
            </button>
          </form>
        ) : null}
      </section>
      {showHostCta ? (
        <section className="panel host-cta">
          <div>
            <div className="panel-title">{t('hostingJam')}</div>
            <div className="muted">{t('startJamHelp')}</div>
          </div>
          <a className="primary-link" href="/admin">
            {t('startJam')}
          </a>
        </section>
      ) : null}
    </div>
  );
}

function formatErrorDetails(details) {
  if (!details) return '';

  const spotifyMessage = details.spotify?.error?.message;
  const spotifyReason = details.spotify?.error?.reason;
  const method = details.method;
  const path = details.path;
  const context = details.context;
  const parts = [];

  if (details.diagnosis) parts.push(details.diagnosis);
  if (spotifyMessage && spotifyMessage !== 'Forbidden') parts.push(spotifyMessage);
  if (spotifyReason) parts.push(spotifyReason);
  if (method && path) parts.push(`${method} ${path}`);
  if (context?.playlistOwnerId || context?.hostUserId) {
    parts.push(
      `host=${context.hostUserId ?? '-'}, owner=${context.playlistOwnerId ?? '-'}`
    );
  }
  if (context?.tokenScope) parts.push(`scopes=${context.tokenScope}`);

  return parts.join(' · ');
}

function RequestButton({ onRequest, label, className = 'icon-button text-button' }) {
  const [status, setStatus] = useState('idle');

  async function requestTrack() {
    if (status !== 'idle') return;
    setStatus('sending');
    try {
      await onRequest();
      setStatus('sent');
      window.setTimeout(() => setStatus('idle'), 1200);
    } catch {
      setStatus('idle');
    }
  }

  const isSending = status === 'sending';
  const isSent = status === 'sent';

  return (
    <button
      className={`${className} request-button ${isSending ? 'is-sending' : ''} ${isSent ? 'is-sent' : ''}`}
      type="button"
      onClick={requestTrack}
      disabled={status !== 'idle'}
      aria-label={label}
      aria-busy={isSending}
    >
      {isSending ? <LoaderCircle size={16} /> : isSent ? <Check size={16} /> : <Plus size={16} />}
      <span>{label}</span>
    </button>
  );
}

function TrackRow({
  track,
  item,
  rank,
  action,
  actionLabel,
  icon = <Plus size={16} />,
  meta,
  dragHandle,
  variant = '',
  isRequestAction = false
}) {
  return (
    <div
      className={`track-row ${rank ? 'has-rank' : ''} ${
        item?.isCurrent ? 'is-current' : ''
      } ${variant}`.trim()}
    >
      {dragHandle}
      {rank ? <div className="track-rank">{rank}</div> : null}
      <img
        className="cover"
        src={track.image || '/placeholder-album.svg'}
        alt=""
      />
      <div className="track-main">
        <div className="track-title">{track.name}</div>
        <div className="track-meta">
          {track.artists?.join(', ') || 'Spotify'}
          {item?.guestLabel ? ` · ${item.guestLabel}` : ''}
          {meta ? ` · ${meta}` : ''}
        </div>
      </div>
      <div className="track-duration">{formatDuration(track.durationMs)}</div>
      {action ? (
        isRequestAction ? (
          <RequestButton onRequest={action} label={actionLabel} />
        ) : (
          <button
            className="icon-button text-button"
            type="button"
            onClick={action}
            aria-label={actionLabel}
          >
            {icon}
            <span>{actionLabel}</span>
          </button>
        )
      ) : null}
    </div>
  );
}

function GuestNameForm({ initialName = '', title, placeholder, submitLabel, onSave }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);

  function save(event) {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName) return;
    onSave(nextName);
  }

  return (
    <form className="setup-form" onSubmit={save}>
      <label>
        {title ? <span>{title}</span> : null}
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={40}
          autoComplete="nickname"
          placeholder={placeholder}
          required
        />
      </label>
      <button type="submit">{submitLabel || t('saveName')}</button>
    </form>
  );
}

function usePlaybackProgress(current) {
  const [progressMs, setProgressMs] = useState(current?.progressMs ?? 0);
  const trackId = current?.track?.id ?? '';
  const durationMs = current?.track?.durationMs ?? 0;
  const isPlaying = Boolean(current?.isPlaying);

  useEffect(() => {
    const receivedAt = Date.now();
    const baseProgress = Number(current?.progressMs ?? 0);
    setProgressMs(baseProgress);

    if (!isPlaying || !durationMs) return undefined;

    const interval = window.setInterval(() => {
      const elapsed = Date.now() - receivedAt;
      setProgressMs(Math.min(baseProgress + elapsed, durationMs));
    }, 500);

    return () => window.clearInterval(interval);
  }, [trackId, current?.progressMs, isPlaying, durationMs]);

  if (!durationMs) return 0;
  return Math.min(Math.max((progressMs / durationMs) * 100, 0), 100);
}

function formatQueueTime(items) {
  const totalMs = items.reduce((sum, item) => sum + Number(item.track?.durationMs || 0), 0);
  const minutes = Math.round(totalMs / 60000);
  if (!minutes) return '—';
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`;
}

function useScreenWakeLock() {
  const sentinelRef = useRef(null);

  const requestLock = useCallback(async () => {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      sentinelRef.current = sentinel;
      sentinel.addEventListener('release', () => {
        if (sentinelRef.current === sentinel) {
          sentinelRef.current = null;
        }
      });
    } catch {}
  }, []);

  useEffect(() => {
    requestLock();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !sentinelRef.current) requestLock();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      sentinelRef.current?.release();
    };
  }, [requestLock]);

}

function useAlbumAccent(imageUrl) {
  const [accent, setAccent] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!imageUrl || imageUrl === '/placeholder-album.svg') {
      setAccent(null);
      return undefined;
    }

    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, 32, 32);
        const pixels = context.getImageData(0, 0, 32, 32).data;
        let red = 0;
        let green = 0;
        let blue = 0;
        let count = 0;

        for (let index = 0; index < pixels.length; index += 16) {
          const [r, g, b, alpha] = pixels.slice(index, index + 4);
          const highest = Math.max(r, g, b);
          const lowest = Math.min(r, g, b);
          if (alpha < 200 || highest - lowest < 28 || highest < 35) continue;
          red += r;
          green += g;
          blue += b;
          count += 1;
        }

        if (!count) throw new Error('No usable album colors');
        red /= count;
        green /= count;
        blue /= count;
        const highest = Math.max(red, green, blue) / 255;
        const lowest = Math.min(red, green, blue) / 255;
        const delta = highest - lowest;
        let hue = 0;
        if (delta) {
          if (highest === red / 255) hue = ((green - blue) / 255 / delta) % 6;
          else if (highest === green / 255) hue = (blue - red) / 255 / delta + 2;
          else hue = (red - green) / 255 / delta + 4;
        }
        hue = Math.round((hue * 60 + 360) % 360);
        if (!cancelled) setAccent(`hsl(${hue} 88% 72%)`);
      } catch {
        if (!cancelled) setAccent(null);
      }
    };
    image.onerror = () => {
      if (!cancelled) setAccent(null);
    };
    image.src = imageUrl;
    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  return accent;
}

function TvInviteQr({ inviteUrl }) {
  const { t } = useTranslation();
  const [qrDataUrl, setQrDataUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!inviteUrl) {
      setQrDataUrl('');
      return undefined;
    }

    QRCode.toDataURL(inviteUrl, {
      margin: 1,
      width: 300,
      color: { dark: '#07100b', light: '#f7fff9' }
    }).then((dataUrl) => {
      if (!cancelled) setQrDataUrl(dataUrl);
    });

    return () => {
      cancelled = true;
    };
  }, [inviteUrl]);

  if (!qrDataUrl) return null;

  return (
    <aside className="tv-invite" aria-label={t('tvJoinJam')}>
      <img src={qrDataUrl} alt={t('tvJoinJam')} />
      <div><strong>{t('tvJoinJam')}</strong><span>{t('tvJoinHelp')}</span></div>
    </aside>
  );
}

function TvDisplay() {
  const { t } = useTranslation();
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const displayInviteToken = useMemo(
    () => query.get('invite') || getInviteToken(),
    [query]
  );
  const [slideIndex, setSlideIndex] = useState(() => {
    const requested = query.get('mode');
    return Math.max(0, ['spotlight', 'queue', 'crowd'].indexOf(requested));
  });
  const [session, setSession] = useState(null);
  const [current, setCurrent] = useState(null);
  const [error, setError] = useState('');
  const [slideCycle, setSlideCycle] = useState(0);
  const crowdViewportRef = useRef(null);
  const crowdListRef = useRef(null);
  const [crowdScrollDistance, setCrowdScrollDistance] = useState(0);
  const progress = usePlaybackProgress(current);
  useScreenWakeLock();

  useEffect(() => {
    document.documentElement.classList.add('tv-viewport');
    return () => document.documentElement.classList.remove('tv-viewport');
  }, []);

  useEffect(() => {
    if (displayInviteToken) setInviteToken(displayInviteToken);
  }, [displayInviteToken]);

  const refresh = useSingleFlightCallback(async () => {
    const nextSession = await api.session();
    const nextCurrent = nextSession?.host?.authenticated && nextSession?.host?.playlistId
      ? await api.current()
      : { current: null };
    setSession(nextSession);
    setCurrent(nextCurrent.playbackUnavailable ? { unavailable: true } : nextCurrent.current);
    setError('');
  });

  usePolling(() => refresh().catch((err) => setError(err.message)), 5000);

  const slides = useMemo(() => [
    { id: 'spotlight', label: t('tvSpotlight') },
    { id: 'queue', label: t('tvQueueWall') },
    { id: 'crowd', label: t('tvTheCrowd') }
  ], [t]);
  const activeSlide = slides[slideIndex];
  const selectSlide = useCallback((index) => {
    setSlideIndex(index);
    setSlideCycle((cycle) => cycle + 1);
  }, []);

  useEffect(() => {
    function onKeyDown(event) {
      const index = Number(event.key) - 1;
      if (index >= 0 && index < slides.length) selectSlide(index);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectSlide, slides.length]);

  const track = current?.track;
  const isPlaybackPaused = Boolean(!current && session?.sync?.manualPause);
  const queue = (session?.queue || []).filter((item) => item.track?.id !== track?.id);
  const nextTrack = queue[0];
  const image = track?.image || '/placeholder-album.svg';
  const albumAccent = useAlbumAccent(image);
  const requesterStats = session?.requesterStats || [];
  const prefersReducedMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    []
  );
  const crowdCanOverflow = requesterStats.length > 6;
  const crowdNeedsScroll = crowdScrollDistance > 0 && !prefersReducedMotion;
  const crowdFirstScrollDuration = crowdNeedsScroll
    ? Math.max(8000, Math.round(crowdScrollDistance * 30))
    : 0;
  const timerDuration = activeSlide.id === 'crowd' && crowdNeedsScroll ? 20000 : 10000;
  const timerDelay = activeSlide.id === 'crowd' ? crowdFirstScrollDuration : 0;
  const slideDuration = timerDelay + timerDuration;

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSlideIndex((index) => (index + 1) % slides.length);
      setSlideCycle((cycle) => cycle + 1);
    }, slideDuration);
    return () => window.clearTimeout(timeout);
  }, [slideCycle, slideDuration, slides.length]);

  useEffect(() => {
    if (activeSlide.id !== 'crowd' || !crowdCanOverflow) {
      setCrowdScrollDistance(0);
      return undefined;
    }

    const measure = () => {
      const viewport = crowdViewportRef.current;
      const list = crowdListRef.current;
      if (!viewport || !list) return;
      setCrowdScrollDistance(Math.max(list.scrollHeight - viewport.clientHeight, 0));
    };

    measure();
    if (!('ResizeObserver' in window)) {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(crowdViewportRef.current);
    observer.observe(crowdListRef.current);
    return () => observer.disconnect();
  }, [activeSlide.id, crowdCanOverflow, requesterStats.length]);

  function renderSlide() {
    if (activeSlide.id === 'queue') {
      return (
        <section className="tv-slide tv-queue-wall" aria-label={t('tvQueueWall')}>
          <div className="tv-slide-heading"><h1>{t('upNext')}</h1><span>{t('tvQueueCount', { count: queue.length })}</span></div>
          <div className="tv-wall-list">
            {queue.slice(0, 8).map((item, index) => (
              <div className={`tv-wall-row ${index === 0 ? 'is-next' : ''}`} key={item.id}>
                <b>{index + 1}</b><img src={item.track.image || '/placeholder-album.svg'} alt="" />
                <strong>{item.track.name}</strong><span>{item.track.artists?.join(', ') || 'Spotify'}</span>
                    <em>{item.guestLabel}</em><time>{formatDuration(item.track.durationMs)}</time>
              </div>
            ))}
            {!queue.length ? <div className="tv-empty">{t('tvQueueOpen')}</div> : null}
          </div>
        </section>
      );
    }

    if (activeSlide.id === 'crowd') {
      const maximum = requesterStats[0]?.count || 1;
      return (
        <section className="tv-slide tv-crowd" aria-label={t('tvTheCrowd')}>
          <div className="tv-slide-heading"><h1>{t('tvRequesters')}</h1><span>{t('tvLeaderboardHelp')}</span></div>
          <div
            ref={crowdViewportRef}
            className={`tv-crowd-scroll-viewport ${crowdCanOverflow ? 'can-scroll' : ''} ${crowdNeedsScroll ? 'is-scrolling' : ''}`}
            style={{
              '--tv-crowd-scroll-distance': `${crowdScrollDistance}px`,
              '--tv-crowd-first-scroll-duration': `${crowdFirstScrollDuration}ms`,
              '--tv-crowd-loop-duration': `${crowdFirstScrollDuration * 2}ms`
            }}
          >
            <div className="tv-crowd-initial-scroll">
              <div ref={crowdListRef} className="tv-crowd-list">
                {requesterStats.map((requester, index) => (
                  <div className={`tv-crowd-row ${index === 0 ? 'is-leader' : ''}`} key={requester.id}>
                    <b>{index + 1}</b><span className="tv-avatar">{requester.name.slice(0, 1).toUpperCase()}</span>
                    <strong>{requester.name}</strong><output>{requester.count}</output>
                    <span className="tv-contribution"><i style={{ width: `${(requester.count / maximum) * 100}%` }} /></span>
                  </div>
                ))}
                {!requesterStats.length ? <div className="tv-empty">{t('tvNoRequestsYet')}</div> : null}
              </div>
            </div>
          </div>
        </section>
      );
    }

    return (
      <section className="tv-slide tv-spotlight" aria-label={t('nowPlaying')}>
        <div className="tv-album-wrap"><img className="tv-album" src={image} alt="" /><span className="tv-vinyl" aria-hidden="true" /></div>
        <div className="tv-now-copy">
          <div className="tv-kicker"><Radio size={16} /> {t('nowPlaying')}</div>
          <h1>{track?.name || (isPlaybackPaused ? t('playbackPaused') : t('tvWaitingForMusic'))}</h1>
          <p>{track?.artists?.join(', ') || (isPlaybackPaused ? t('resumeInSpotify') : t('tvReady'))}</p>
          {current?.guestLabel ? <div className="tv-requester">{t('requestedBy')} <strong>{current.guestLabel}</strong></div> : null}
          <div className="tv-progress" aria-label={t('playbackProgress')}><span style={{ width: `${progress}%` }} /></div>
        </div>
      </section>
    );
  }

  return (
    <main
      className={`tv-screen tv-slide-${activeSlide.id}`}
      style={{
        ...(albumAccent ? { '--tv-accent': albumAccent } : {}),
        '--tv-slide-duration': `${timerDuration}ms`,
        '--tv-slide-delay': `${timerDelay}ms`
      }}
    >
      <div className="tv-artwash" style={{ backgroundImage: `url(${image})` }} aria-hidden="true" />
      <header className="tv-header">
        <BrandMark compact />
        <div className="tv-live"><span /> {t('tvLiveJam')}</div>
        <button
          className="tv-exit-button"
          type="button"
          onClick={() => window.location.assign('/')}
          aria-label={t('tvExit')}
          title={t('tvExit')}
        >
          <LogOut size={16} />
        </button>
        <nav className="tv-mode-picker" aria-label={t('tvLayoutExamples')}>
          {slides.map(({ id, label }, index) => (
            <button key={id} type="button" className={activeSlide.id === id ? 'is-active' : ''} onClick={() => selectSlide(index)}>
              <small>{index + 1}</small>{label}
            </button>
          ))}
        </nav>
      </header>

      {renderSlide()}
      <footer className="tv-bottom-rail">
        <section className="tv-rail-track"><span>{t('nowPlaying')}</span><img src={image} alt="" /><div><strong>{track?.name || t('tvWaitingForMusic')}</strong><small>{track?.artists?.join(', ') || 'EasyJAM'}</small></div></section>
        <section className="tv-rail-track tv-rail-next"><span>{t('upNext')}</span>{nextTrack ? <><img src={nextTrack.track.image || '/placeholder-album.svg'} alt="" /><div><strong>{nextTrack.track.name}</strong><small>{nextTrack.track.artists?.join(', ') || 'Spotify'} · {nextTrack.guestLabel}</small></div></> : <small>{t('emptyQueue')}</small>}</section>
        <TvInviteQr inviteUrl={session?.displayInviteUrl} />
      </footer>
      <div className="tv-slide-timer" role="progressbar" aria-label={t('tvSlideTimer')} aria-valuemin={0} aria-valuemax={timerDuration / 1000}>
        <span key={`${activeSlide.id}-${slideCycle}-${timerDelay}-${timerDuration}`} />
      </div>
      {error ? <div className="tv-error">{error}</div> : null}
    </main>
  );
}

function CurrentTrack({ current, isPlaybackPaused = false, isPlaybackUnavailable = false, onSubmitTrack, queueCount }) {
  const { t } = useTranslation();
  const track = current?.track;
  const progressPercent = usePlaybackProgress(current);

  return (
    <section className="now-playing">
      <div className="section-heading now-heading">
        <div>
          <h2 className="section-label">{t('nowPlaying')}</h2>
        </div>
        {typeof queueCount === 'number' ? (
          <div className="status-pill subtle">{queueCount} {t('tracks')}</div>
        ) : null}
      </div>
      {track ? (
        <div className="player-hero">
          <img className="album-glow" src={track.image || '/placeholder-album.svg'} alt="" />
          <div className="album-stage">
            <img
              className="album-hero"
              src={track.image || '/placeholder-album.svg'}
              alt=""
            />
          </div>
          <div className="track-hero-copy">
            <div className="track-hero-title-row">
              <div className="track-hero-title">{track.name}</div>
            </div>
            <div className="track-hero-meta">
              {track.artists?.join(', ') || 'Spotify'}
              {current.isPlaying ? '' : ` · ${t('playbackPaused')}`}
            </div>
            {current.guestLabel ? (
              <div className="track-hero-requester">
                {t('requestedBy')} {current.guestLabel}
              </div>
            ) : null}
          </div>
          <div
            className="player-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progressPercent)}
            aria-label={t('playbackProgress')}
          >
            <span style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      ) : (
        <div className="empty-player">
          <div className="sound-orbit" aria-hidden="true">
            <div className="sound-orbit-core">
              <span className="record-label" />
              <span className="record-hole" />
            </div>
          </div>
          <div className="empty-copy">
            <strong>{isPlaybackUnavailable ? t('playbackChecking') : isPlaybackPaused ? t('playbackPaused') : t('noTrack')}</strong>
            {isPlaybackPaused ? <small>{t('resumeInSpotify')}</small> : null}
          </div>
        </div>
      )}
      {onSubmitTrack ? (
        <button className="primary-action" type="button" onClick={onSubmitTrack}>
          <Plus size={18} />
          {t('submitTrack')}
        </button>
      ) : null}
    </section>
  );
}

function UpNextPreview({ items, onViewAll }) {
  const { t } = useTranslation();
  const previewItems = items.slice(0, 3);

  return (
    <section className="up-next">
      <div className="section-heading">
        <h2 className="section-label">{t('upNext')}</h2>
        <button className="link-button" type="button" onClick={onViewAll}>
          {t('viewAll')}
        </button>
      </div>
      {previewItems.length ? (
        <div className="track-list">
          {previewItems.map((item, index) => (
            <TrackRow
              key={item.id}
              item={item}
              rank={index + 1}
              track={item.track}
              variant="queue-preview-row"
            />
          ))}
        </div>
      ) : (
        <Feedback message={t('emptyQueue')} className="compact-state" />
      )}
    </section>
  );
}

function QueueList({ items, emptyText, onRemove, removeLabel, admin = false }) {
  if (!items.length) {
    return <Feedback message={emptyText} />;
  }

  return (
    <div className="track-list">
      {items.map((item, index) => (
        <TrackRow
          key={item.id}
          item={item}
          rank={index + 1}
          track={item.track}
          meta={admin ? `#${index + 1}` : null}
          action={onRemove ? () => onRemove(item.id) : null}
          actionLabel={removeLabel}
          icon={<Trash2 size={16} />}
        />
      ))}
    </div>
  );
}

function HistoryList({ items }) {
  const { t } = useTranslation();
  const pageSize = 10;
  const [page, setPage] = useState(0);
  const pageCount = Math.max(Math.ceil(items.length / pageSize), 1);
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = items.slice(safePage * pageSize, safePage * pageSize + pageSize);

  useEffect(() => {
    if (page !== safePage) setPage(safePage);
  }, [page, safePage]);

  return (
    <>
      <QueueList items={pageItems} emptyText={t('emptyHistory')} removeLabel={t('remove')} />
      {items.length > pageSize ? (
        <div className="pager history-pager">
          <button type="button" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            {t('previous')}
          </button>
          <span>{safePage + 1} / {pageCount}</span>
          <button
            type="button"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)}
          >
            {t('next')}
          </button>
        </div>
      ) : null}
    </>
  );
}

function SearchPanel({ onAdd, onClose }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [tracks, setTracks] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const debouncedQuery = useDebouncedValue(query, 300);

  useEffect(() => {
    let cancelled = false;
    if (debouncedQuery.trim().length < 2) {
      setTracks([]);
      setError('');
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    api
      .search(debouncedQuery.trim())
      .then((result) => {
        if (!cancelled) {
          setTracks(result.tracks);
          setError('');
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  return (
    <section className="submit-screen search-surface">
      <div className="screen-title">
        <h1>{t('submitTrack')}</h1>
        {onClose ? (
          <button
            className="icon-button close-button"
            type="button"
            onClick={onClose}
            aria-label={t('close')}
          >
            <X size={17} />
          </button>
        ) : null}
      </div>
      <label className="search-field">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('searchPlaceholder')}
        />
      </label>
      <Feedback message={error} tone="error" />
      {loading ? <Feedback message={t('searching')} className="loading-state" /> : null}
      {!loading && debouncedQuery.trim().length >= 2 && !tracks.length && !error ? (
        <Feedback message={t('noSearchResults')} />
      ) : null}
      <div className="track-list compact">
        {tracks.map((track) => (
          <TrackRow
            key={track.uri}
            track={track}
            action={() => onAdd(track)}
            actionLabel={t('add')}
            isRequestAction
          />
        ))}
      </div>
    </section>
  );
}

function PlaylistBrowser({ playlist, onAdd, admin = false, embedded = false }) {
  const { t } = useTranslation();
  const isImportedPlaylist =
    playlist?.source === 'import' && Array.isArray(playlist.tracks);
  const [tracks, setTracks] = useState([]);
  const [offset, setOffset] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  const refreshRequestedRef = useRef(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState({ key: 'addedAt', direction: 'desc' });

  useEffect(() => {
    setOffset(0);
    setSort({ key: 'addedAt', direction: 'desc' });
  }, [playlist?.id]);

  useEffect(() => {
    if (!playlist?.id) return;
    if (isImportedPlaylist) {
      setError('');
      setLoading(false);
      setTracks(playlist.tracks.slice(offset, offset + 30));
      setTotal(playlist.tracks.length);
      return;
    }
    let cancelled = false;
    const forceRefresh = refreshRequestedRef.current;
    refreshRequestedRef.current = false;
    setError('');
    setLoading(true);
    async function loadPage() {
      try {
        const result = await api.playlistTracks(playlist.id, offset, admin, forceRefresh);
        // Spotify's playlist items are oldest-first. Reverse the API page order
        // for newest-first date sorting so page 1 contains the newest tracks.
        const pageSize = result.limit || 30;
        const pageCount = Math.ceil(result.total / pageSize);
        const pageIndex = Math.floor(offset / pageSize);
        const sourceOffset =
          sort.key === 'addedAt' && sort.direction === 'desc'
            ? Math.max(pageCount - pageIndex - 1, 0) * pageSize
            : offset;
        const page = sourceOffset === offset
          ? result
          : await api.playlistTracks(playlist.id, sourceOffset, admin, forceRefresh);
        if (cancelled) return;
        setTracks(page.tracks);
        setTotal(page.total);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        const details = formatErrorDetails(err.details);
        const status = err.status ? `HTTP ${err.status}` : '';
        setError([err.message, status, details].filter(Boolean).join(' · '));
        setLoading(false);
      }
    }

    loadPage();
    return () => {
      cancelled = true;
    };
  }, [admin, isImportedPlaylist, offset, playlist?.id, playlist?.tracks, refreshTick, sort]);

  const sortedTracks = useMemo(() => {
    const valueFor = (track) => {
      if (sort.key === 'artist') return track.artists?.join(', ') ?? '';
      if (sort.key === 'name') return track.name ?? '';
      if (sort.key === 'album') return track.album ?? '';
      if (sort.key === 'durationMs') return track.durationMs ?? 0;
      const timestamp = track.addedAt ? Date.parse(track.addedAt) : NaN;
      return Number.isFinite(timestamp) ? timestamp : null;
    };

    return tracks
      .map((track, index) => ({ track, index }))
      .sort((leftEntry, rightEntry) => {
      const leftValue = valueFor(leftEntry.track);
      const rightValue = valueFor(rightEntry.track);
      if (leftValue === null || rightValue === null) {
        if (leftValue === rightValue) return leftEntry.index - rightEntry.index;
        const missingFirst = sort.direction === 'asc';
        const leftIsMissing = leftValue === null;
        return leftIsMissing === missingFirst ? -1 : 1;
      }
      const comparison =
        typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : String(leftValue).localeCompare(String(rightValue), i18n.language);
      if (comparison !== 0) return sort.direction === 'asc' ? comparison : -comparison;
      return leftEntry.index - rightEntry.index;
    })
      .map(({ track }) => track);
  }, [sort, tracks]);

  function toggleSort(key) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc'
    }));
  }

  function sortLabel(key, label) {
    const active = sort.key === key;
    return (
      <button className={`table-sort-button ${active ? 'active' : ''}`} type="button" onClick={() => toggleSort(key)}>
        {label}
        <span aria-hidden="true">{active ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
      </button>
    );
  }

  if (!playlist) return null;

  return (
    <section className={`${embedded ? '' : 'panel '}playlist-browser-panel`}>
      <div className="playlist-heading">
        <div>
          <div className="panel-title">
            <ListMusic size={18} />
            {playlist.name}
          </div>
          <div className="muted">
            {playlist.owner ? `${t('by')} ${playlist.owner}` : ''}
            {total ? ` · ${total} ${t('total')}` : ''}
          </div>
        </div>
        <div className="toolbar">
          {!isImportedPlaylist ? (
            <button
              type="button"
              onClick={() => {
                refreshRequestedRef.current = true;
                setRefreshTick((tick) => tick + 1);
              }}
              disabled={loading}
            >
              <RefreshCcw size={16} />
              {t('refresh')}
            </button>
          ) : null}
          {playlist.url ? (
            <a className="small-link" href={playlist.url} target="_blank" rel="noreferrer">
              {t('openSpotify')}
            </a>
          ) : null}
        </div>
      </div>
      <Feedback message={error} tone="error" />
      {loading ? <Feedback message={t('loading')} className="loading-state" /> : null}
      {tracks.length ? (
        <div className="playlist-table-wrap">
          <table className={`playlist-table ${onAdd ? 'has-request-action' : ''}`}>
            <thead>
              <tr>
                {onAdd ? <th scope="col" aria-label={t('add')} /> : null}
                <th scope="col">{sortLabel('artist', t('artist'))}</th>
                <th scope="col">{sortLabel('name', t('trackName'))}</th>
                <th scope="col">{sortLabel('album', t('album'))}</th>
                <th scope="col">{sortLabel('durationMs', t('length'))}</th>
                <th scope="col">{sortLabel('addedAt', t('addedToPlaylist'))}</th>
              </tr>
            </thead>
            <tbody>
              {sortedTracks.map((track, index) => (
                <tr key={`${track.uri}-${index}`}>
                  {onAdd ? (
                    <td>
                      <RequestButton onRequest={() => onAdd(track)} label={t('add')} />
                    </td>
                  ) : null}
                  <td>{track.artists?.join(', ') || 'Spotify'}</td>
                  <td className="playlist-track-name">
                    <div className="playlist-track-name-content">
                      <img src={track.image || '/placeholder-album.svg'} alt="" />
                      <span>{track.name}</span>
                    </div>
                  </td>
                  <td>{track.album || '—'}</td>
                  <td>{formatDuration(track.durationMs) || '—'}</td>
                  <td>{formatDateTime(track.addedAt) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !loading ? <Feedback message={t('noPlaylistTracks')} /> : null}
      <div className="pager">
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(offset - 30, 0))}
        >
          {t('previous')}
        </button>
        <button
          type="button"
          disabled={offset + 30 >= total}
          onClick={() => setOffset(offset + 30)}
        >
          {t('next')}
        </button>
      </div>
    </section>
  );
}

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"' && quoted) {
      cell += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }

  cells.push(cell.trim());
  return cells;
}

function normalizeImportHeader(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function parsePlaylistImport(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return [];

  const firstRow = parseCsvLine(lines[0]);
  const headers = firstRow.map(normalizeImportHeader);
  const titleIndex = headers.findIndex((header) => ['title', 'track', 'trackname', 'song', 'name'].includes(header));
  const artistIndex = headers.findIndex((header) => ['artist', 'artists', 'artistname'].includes(header));
  const albumIndex = headers.findIndex((header) => header === 'album');
  const isrcIndex = headers.findIndex((header) => header === 'isrc');
  const spotifyIdIndex = headers.findIndex((header) => header === 'spotifyid');
  const hasHeader = titleIndex >= 0 || artistIndex >= 0 || isrcIndex >= 0;
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines
    .map((line) => {
      const cells = parseCsvLine(line);
      const rawTitle = String(cells[hasHeader ? titleIndex : 0] ?? '').trim();
      const rawArtist = String(cells[hasHeader ? artistIndex : 1] ?? '').trim();
      const textSeparator = !hasHeader ? rawTitle.indexOf(' - ') : -1;
      return {
        title: textSeparator >= 0 ? rawTitle.slice(textSeparator + 3).trim() : rawTitle,
        artist: textSeparator >= 0 ? rawTitle.slice(0, textSeparator).trim() : rawArtist,
        album: String(cells[hasHeader ? albumIndex : 2] ?? '').trim(),
        isrc: String(cells[hasHeader ? isrcIndex : 3] ?? '').trim(),
        spotifyId: String(cells[hasHeader ? spotifyIdIndex : 4] ?? '').trim()
      };
    })
    .filter((row) => row.title);
}

function normalizeMatchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function chooseImportedTrack(row, tracks) {
  const title = normalizeMatchText(row.title);
  const artist = normalizeMatchText(row.artist);
  return [...tracks].sort((left, right) => {
    const score = (track) => {
      const trackTitle = normalizeMatchText(track.name);
      const trackArtists = normalizeMatchText(track.artists?.join(' '));
      return (trackTitle === title ? 4 : trackTitle.includes(title) || title.includes(trackTitle) ? 2 : 0) +
        (artist && (trackArtists === artist || trackArtists.includes(artist)) ? 3 : 0);
    };
    return score(right) - score(left);
  })[0] ?? null;
}

function PlaylistImport({ onImported }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [processing, setProcessing] = useState(false);

  async function handleFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setFileName(file.name);
    setError('');
    setStatus('');
    setProcessing(true);

    try {
      const rows = parsePlaylistImport(await file.text()).slice(0, 500);
      if (!rows.length) throw new Error(t('playlistImportEmpty'));

      setProgress({ current: 0, total: rows.length });
      const matchedTracks = [];
      let skipped = 0;

      for (const [index, row] of rows.entries()) {
        try {
          const directTrack = /^[A-Za-z0-9]{22}$/.test(row.spotifyId)
            ? {
                id: row.spotifyId,
                uri: `spotify:track:${row.spotifyId}`,
                name: row.title,
                artists: row.artist ? [row.artist] : [],
                album: row.album,
                image: null,
                durationMs: 0,
                explicit: false
              }
            : null;
          const result = directTrack
            ? null
            : await api.search([row.title, row.artist].filter(Boolean).join(' '));
          const track = directTrack || chooseImportedTrack(row, result?.tracks ?? []);
          if (track) matchedTracks.push(track);
          else skipped += 1;
        } catch {
          skipped += 1;
        }
        setProgress({ current: index + 1, total: rows.length });
      }

      if (!matchedTracks.length) throw new Error(t('playlistImportNoMatches'));
      const importedAt = new Date().toISOString();
      const result = await onImported({
        name: file.name.replace(/\.(csv|txt)$/i, '') || t('importPlaylist'),
        tracks: matchedTracks.map((track) => ({ ...track, addedAt: importedAt }))
      });
      setStatus(t('playlistImportComplete', {
        imported: result.imported,
        skipped
      }));
    } catch (importError) {
      setError(importError.message || t('playlistImportFailed'));
    } finally {
      setProcessing(false);
    }
  }

  return (
    <>
      <button className="playlist-import-trigger" type="button" onClick={() => setOpen(true)}>
        <FileUp size={15} />
        {t('importPlaylist')}
      </button>
      {open ? createPortal(
        <div className="playlist-import-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !processing) setOpen(false);
        }}>
          <section className="playlist-import-dialog" role="dialog" aria-modal="true" aria-labelledby="playlist-import-title">
            <div className="playlist-import-heading">
              <div>
                <div className="panel-title" id="playlist-import-title">
                  <FileUp size={18} />
                  {t('importPlaylist')}
                </div>
                <p className="muted">{t('playlistImportHelp')}</p>
                <p className="playlist-import-format">{t('playlistImportFormats')}</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setOpen(false)} disabled={processing} aria-label={t('close')}>
                <X size={17} />
              </button>
            </div>
            <ol className="playlist-import-steps">
              {Array.from({ length: 9 }, (_, index) => (
                <li key={index}>{t(`playlistImportStep${index + 1}`)}</li>
              ))}
            </ol>
            <a className="small-link" href="https://www.tunemymusic.com/" target="_blank" rel="noreferrer">
              {t('openTuneMyMusic')}
            </a>
            <label className={`file-upload ${processing ? 'is-disabled' : ''}`}>
              <FileUp size={17} />
              <span>{fileName || t('choosePlaylistFile')}</span>
              <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={handleFile} disabled={processing} />
            </label>
            {processing ? <Feedback message={`${t('playlistImportMatching')} ${progress.current}/${progress.total}`} className="loading-state" /> : null}
            {error ? <Feedback message={error} tone="error" /> : null}
            {status ? <Feedback message={status} /> : null}
          </section>
        </div>,
        document.body
      ) : null}
    </>
  );
}

function PlaylistPanel({ guestId, guestName, onAdd, pinnedPlaylists, allowPlaylistLinks = true }) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [savedPlaylists, setSavedPlaylists] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(savedPlaylistsKey) || '[]');
    } catch {
      return [];
    }
  });
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [error, setError] = useState('');

  const sortedPlaylists = savedPlaylists;

  useEffect(() => {
    if (!guestId) return;

    let cancelled = false;
    api
      .guestPlaylists(guestId)
      .then((result) => {
        if (cancelled || !Array.isArray(result.playlists)) return;
        setSavedPlaylists(result.playlists);
        localStorage.setItem(savedPlaylistsKey, JSON.stringify(result.playlists));
      })
      .catch(() => {
        // Local storage remains the offline fallback for this convenience list.
      });

    return () => {
      cancelled = true;
    };
  }, [guestId]);

  async function persist(playlists) {
    setSavedPlaylists(playlists);
    localStorage.setItem(savedPlaylistsKey, JSON.stringify(playlists));
    if (guestId) {
      try {
        const result = await api.saveGuestPlaylists(guestId, playlists);
        setSavedPlaylists(result.playlists);
        localStorage.setItem(savedPlaylistsKey, JSON.stringify(result.playlists));
        return result.playlists;
      } catch (err) {
        setError(err.message);
        throw err;
      }
    }
    return playlists;
  }

  async function savePlaylist(event) {
    event.preventDefault();
    setError('');
    try {
      const result = await api.resolvePlaylist(input);
      const next = [
        { ...result.playlist, addedAt: new Date().toISOString() },
        ...savedPlaylists.filter((playlist) => playlist.id !== result.playlist.id)
      ];
      await persist(next);
      setSelectedPlaylist(next[0]);
      setInput('');
    } catch (err) {
      setError(err.message);
    }
  }

  async function importPlaylist({ name, tracks }) {
    setError('');
    const playlist = {
      id: `import-${crypto.randomUUID()}`,
      name,
      owner: guestName || t('guest'),
      image: tracks.find((track) => track.image)?.image ?? null,
      url: null,
      addedAt: new Date().toISOString(),
      source: 'import',
      tracks
    };
    const persisted = await persist([playlist, ...savedPlaylists]);
    setSelectedPlaylist(persisted.find((item) => item.id === playlist.id) ?? playlist);
    return { imported: tracks.length };
  }

  return (
    <section className={`panel playlist-workspace ${selectedPlaylist ? 'is-browsing' : ''}`}>
      <div className="playlist-library-panel">
        <div className="panel-title">
          <ListMusic size={18} />
          {t('playlist')}
        </div>
        {allowPlaylistLinks ? (
          <form className="inline-form" onSubmit={savePlaylist}>
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={t('playlistPlaceholder')}
            />
            <button type="submit">
              <Plus size={16} />
              {t('savePlaylist')}
            </button>
          </form>
        ) : null}
        <PlaylistImport onImported={importPlaylist} />
        <Feedback message={error} tone="error" />
        <div className="playlist-library-heading">
          <div className="shelf-title">{t('savedPlaylists')}</div>
        </div>
        <PlaylistShelf playlists={sortedPlaylists} onSelect={setSelectedPlaylist} />
        <PlaylistShelf
          title={t('pinnedPlaylists')}
          playlists={pinnedPlaylists.filter((playlist) => playlist.visibleToGuests !== false)}
          onSelect={setSelectedPlaylist}
        />
      </div>
      <PlaylistBrowser playlist={selectedPlaylist} onAdd={onAdd} embedded />
    </section>
  );
}

function PlaylistShelf({ title, playlists, onSelect }) {
  if (!playlists?.length) return null;

  return (
    <div className="playlist-shelf">
      {title ? <div className="shelf-title">{title}</div> : null}
      <div className="playlist-buttons">
        {playlists.map((playlist) => (
          <button
            className="playlist-chip"
            type="button"
            key={playlist.id}
            onClick={() => onSelect(playlist)}
          >
            {playlist.image ? <img src={playlist.image} alt="" /> : null}
            <span>{playlist.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RecommendationsPanel({ guestId, onAdd, mine }) {
  const { t } = useTranslation();
  const [tracks, setTracks] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function loadRecommendations() {
    setError('');
    setLoading(true);
    try {
      const result = await api.recommendations(guestId);
      setTracks(result.tracks);
    } catch (err) {
      setError(err.message || t('apiUnavailable'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel recommendations-panel">
      <div className="panel-title">
        <RefreshCcw size={18} />
        {t('recommendations')}
      </div>
      <button
        className="recommendation-refresh"
        type="button"
        onClick={loadRecommendations}
        disabled={!mine.length || loading}
        aria-busy={loading}
      >
        <RefreshCcw size={16} />
        {loading ? t('loading') : t('refresh')}
      </button>
      {!mine.length ? <Feedback message={t('recommendationHint')} /> : null}
      <Feedback message={error} tone="error" />
      <div className="track-list compact">
        {tracks.map((track) => (
          <TrackRow
            key={track.uri}
            track={track}
            action={() => onAdd(track)}
            actionLabel={t('add')}
            isRequestAction
          />
        ))}
      </div>
    </section>
  );
}

function GuestApp() {
  const { t, toggleLanguage } = useLanguage();
  const guestId = useMemo(() => getGuestId(), []);
  const pathInviteToken = useMemo(() => {
    const match = window.location.pathname.match(/^\/join\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : '';
  }, []);
  const [activeInviteToken, setActiveInviteToken] = useState(
    () => pathInviteToken || getInviteToken()
  );
  const [inviteAccessToken, setInviteAccessTokenState] = useState(
    () => getInviteAccessToken()
  );
  const [inviteInfo, setInviteInfo] = useState(null);
  const [session, setSession] = useState(null);
  const [current, setCurrent] = useState(null);
  const [queueData, setQueueData] = useState({ queue: [], mine: [], history: [] });
  const [tab, setTab] = useState('jam');
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [guestName, setGuestName] = useState(
    () => localStorage.getItem(guestNameKey) || ''
  );
  const [editingProfileName, setEditingProfileName] = useState(false);
  const inviteReady = Boolean(
    inviteInfo?.validToken &&
      (!inviteInfo.pinRequired || (activeInviteToken && inviteAccessToken))
  );

  useEffect(() => {
    if (!pathInviteToken) return;
    setInviteToken(pathInviteToken);
    setActiveInviteToken(pathInviteToken);
  }, [pathInviteToken]);

  useEffect(() => {
    api
      .inviteStatus(activeInviteToken)
      .then((result) => {
        setInviteInfo(result);
        if (result.pinRequired && !result.validToken) {
          clearInviteAccess();
          setInviteAccessTokenState('');
        }
      })
      .catch((err) => setError(err.message));
  }, [activeInviteToken]);

  const refresh = useSingleFlightCallback(async () => {
    const sessionResult = await api.session();
    const currentResult =
      sessionResult?.host?.authenticated && sessionResult?.host?.playlistId
        ? await api.current()
        : { current: null };
    const queueResult = await api.queue(guestId);

    setSession(sessionResult);
    setQueueData(queueResult);
    setCurrent(currentResult.playbackUnavailable ? { unavailable: true } : currentResult.current);
    setError('');
  });

  usePolling(() => {
    refresh().catch((err) => setError(err.message));
  }, inviteReady ? 5000 : null);

  async function saveGuestName(nextName) {
    const normalized = nextName.trim();
    if (!normalized) return;

    localStorage.setItem(guestNameKey, normalized);
    setGuestName(normalized);
    try {
      const result = await api.setGuestName(guestId, normalized);
      setQueueData({
        queue: result.queue,
        mine: result.mine,
        history: result.history ?? queueData.history
      });
    } catch (err) {
      setError(err.message);
    }
  }

  function logoutGuest() {
    clearGuestId();
    clearInviteAccess();
    localStorage.removeItem(guestNameKey);
    localStorage.removeItem(savedPlaylistsKey);
    window.location.assign('/');
  }

  async function addTrack(track) {
    setError('');
    try {
      const result = await api.addTrack(guestId, track, guestName);
      setQueueData({
        queue: result.queue,
        mine: result.mine,
        history: result.history ?? queueData.history
      });
      setToast({ message: t('requestAdded'), tone: 'success' });
    } catch (err) {
      const message = err.code === 'DUPLICATE_UPCOMING_TRACK' ? t('requestAlreadyUpcoming') : err.message;
      setToast({ message, tone: 'error' });
      throw err;
    }
  }

  async function removeMine(itemId) {
    const result = await api.removeMine(guestId, itemId);
    setQueueData({
      queue: result.queue,
      mine: result.mine,
      history: result.history ?? queueData.history
    });
  }

  if (!inviteReady) {
    return (
      <InviteGate
        inviteToken={activeInviteToken}
        showHostCta={!pathInviteToken}
        onVerified={(nextInviteInfo) => {
          setInviteInfo({ ...nextInviteInfo, validToken: true });
          setInviteAccessTokenState(getInviteAccessToken());
        }}
      />
    );
  }

  if (!guestName) {
    return (
      <div className="app-shell">
        <header className="welcome-header">
          <BrandMark />
          <button className="icon-button" type="button" onClick={toggleLanguage}>
            <Globe2 size={17} aria-hidden="true" />
            <span>{t('language')}</span>
          </button>
        </header>

        <Feedback message={error} tone="error" />
        <section className="panel login-panel name-login-panel">
          <GuestNameForm
            placeholder={t('yourName')}
            submitLabel={t('logIn')}
            onSave={saveGuestName}
          />
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell guest-shell">
      <Toast message={toast?.message} tone={toast?.tone} onDone={() => setToast(null)} />
      <header className="topbar">
        <div className="room-identity">
          <BrandMark compact />
        </div>
        <div className="topbar-actions">
          <SessionStatus session={session} />
          <a className="admin-link" href="/admin">
            <Settings size={16} />
            <span>{t('adminLink')}</span>
          </a>
          <button
            className="guest-count-pill"
            type="button"
            onClick={() => setTab('profile')}
            aria-label={t('activeGuests', { count: session?.guestStats?.active ?? 1 })}
          >
            <Users size={15} />
            <span>{session?.guestStats?.active ?? 1}</span>
          </button>
          <button
            className="icon-button topbar-language-button"
            type="button"
            onClick={toggleLanguage}
            aria-label={t('changeLanguage')}
          >
            <Globe2 size={17} aria-hidden="true" />
            <span>{t('language')}</span>
          </button>
        </div>
      </header>

      <Feedback message={error} tone="error" />

      <nav className="tabs" aria-label={t('navigation')}>
        {[
          ['jam', t('jam'), <Home size={17} key="jam" />],
          ['submit', t('submit'), <Plus size={17} key="submit" />],
          ['queue', t('queueShort'), <ListMusic size={17} key="queue" />],
          ['tv', t('jamScreen'), <Radio size={17} key="tv" />],
          ['profile', t('profile'), <User size={17} key="profile" />]
        ].map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? 'active' : ''}
            onClick={() =>
              id === 'tv'
                ? window.location.assign(
                    `/tv?invite=${encodeURIComponent(activeInviteToken)}`
                  )
                : setTab(id)
            }
            aria-current={tab === id ? 'page' : undefined}
          >
            {icon}
            {label}
          </button>
        ))}
      </nav>

      {tab === 'jam' ? (
        <>
            <CurrentTrack
              current={current}
            isPlaybackPaused={Boolean(!current?.track && session?.sync?.manualPause)}
            isPlaybackUnavailable={Boolean(current?.unavailable)}
            queueCount={queueData.queue.length}
            onSubmitTrack={() => setTab('submit')}
          />
          <UpNextPreview items={queueData.queue} onViewAll={() => setTab('queue')} />
        </>
      ) : null}

      {tab === 'queue' ? (
        <section className="screen-stack">
          <div className="screen-title">
            <h1>{t('queueShort')}</h1>
            <div className="screen-actions">
              <span>{queueData.queue.length} {t('tracks')}</span>
            </div>
          </div>
          <QueueList
            items={queueData.queue}
            emptyText={t('emptyQueue')}
            removeLabel={t('remove')}
          />
          {queueData.fallbackTracks?.length ? (
            <>
              <div className="section-label">{t('fallbackTracks')}</div>
              <QueueList items={queueData.fallbackTracks} emptyText={t('emptyQueue')} removeLabel={t('remove')} />
            </>
          ) : null}
          <section className="queue-history">
            <div className="section-heading">
              <h2 className="section-label">{t('history')}</h2>
            </div>
            <HistoryList items={queueData.history ?? []} />
          </section>
        </section>
      ) : null}

      {tab === 'submit' ? (
        <div className="discover-grid">
          <div className="discover-primary">
            <SearchPanel onAdd={addTrack} onClose={() => setTab('jam')} />
            <MiniPlayer current={current} />
          </div>
          <div className="discover-secondary">
            <PlaylistPanel
              guestId={guestId}
              guestName={guestName}
              onAdd={addTrack}
              allowPlaylistLinks={session?.invite?.playlistLinksEnabled !== false}
              pinnedPlaylists={session?.pinnedPlaylists ?? []}
            />
            <RecommendationsPanel
              guestId={guestId}
              onAdd={addTrack}
              mine={queueData.mine}
            />
          </div>
        </div>
      ) : null}

      {tab === 'profile' ? (
        <div className="profile-screen">
          <div className="profile-summary">
            <section className="profile-head">
              <div className="profile-record">
                <div className="avatar">{guestName.slice(0, 1).toUpperCase()}</div>
              </div>
              <div className="profile-copy">
                <div className="profile-name-row">
                  <h1>{guestName}</h1>
                  <button
                    className="profile-edit-button"
                    type="button"
                    onClick={() => setEditingProfileName((editing) => !editing)}
                    aria-label={editingProfileName ? t('cancel') : t('editName')}
                  >
                    <Pencil size={16} />
                  </button>
                </div>
                <div className="muted">{t('guest')}</div>
              </div>
              <button className="icon-button danger-button profile-logout-button" type="button" onClick={logoutGuest}>
                <LogOut size={16} />
                <span>{t('logout')}</span>
              </button>
            </section>
            {editingProfileName ? (
              <section className="panel profile-name-panel">
                <GuestNameForm
                  initialName={guestName}
                  title={t('displayName')}
                  onSave={async (nextName) => {
                    await saveGuestName(nextName);
                    setEditingProfileName(false);
                  }}
                />
              </section>
            ) : null}
            <section className="jam-overview">
              <div>
                <span>{t('queueShort')}</span>
                <strong>{queueData.queue.length}</strong>
              </div>
              <div>
                <span>{t('mine')}</span>
                <strong>{queueData.mine.length}</strong>
              </div>
            </section>
          </div>
          <div className="profile-details">
            <section className="panel flat-panel">
              <div className="panel-title">
                <User size={18} />
                {t('mine')}
              </div>
              <QueueList
                items={queueData.mine}
                emptyText={t('emptyQueue')}
                onRemove={removeMine}
                removeLabel={t('remove')}
              />
            </section>
            <section className="panel flat-panel">
              <div className="panel-title">
                <Users size={18} />
                {t('inviteGuests')}
              </div>
              <InviteQrPanel
                inviteUrl={
                  activeInviteToken
                    ? `${window.location.origin}/join/${activeInviteToken}`
                    : ''
                }
                canInvite={session?.invite?.guestsCanInvite !== false}
                onCopied={() => setToast({ message: t('copied'), tone: 'success' })}
              />
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SortableTrack({ item, onRemove }) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: item.id
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  };

  return (
    <div ref={setNodeRef} style={style}>
      <TrackRow
        item={item}
        track={item.track}
        dragHandle={
          <button
            className="drag-handle"
            type="button"
            aria-label="Drag"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={16} />
          </button>
        }
        action={() => onRemove(item.id)}
        actionLabel={t('remove')}
        icon={<Trash2 size={16} />}
      />
    </div>
  );
}

function AdminQueue({ queue, setQueue, onRemove }) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  );

  async function handleDragEnd(event) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = queue.findIndex((item) => item.id === active.id);
    const newIndex = queue.findIndex((item) => item.id === over.id);
    const nextQueue = arrayMove(queue, oldIndex, newIndex);
    setQueue(nextQueue);
    const result = await api.reorder(nextQueue.map((item) => item.id));
    setQueue(result.queue);
  }

  if (!queue.length) return <Feedback message={t('emptyQueue')} />;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={queue.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        <div className="track-list">
          {queue.map((item) => (
            <SortableTrack key={item.id} item={item} onRemove={onRemove} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function AdminGuests({ guests = [], busy, onKick, onKickAll, onBan }) {
  const { t } = useLanguage();

  return (
    <section className="panel admin-guests-panel">
      <div className="panel-title">
        <UsersRound size={18} />
        {t('visitors')}
        <span className="status-pill">{guests.length}</span>
      </div>
      <p className="muted visitor-help">{t('visitorsHelp')}</p>
      {guests.length ? (
        <div className="visitor-list">
          {guests.map((guest) => (
            <div className="visitor-row" key={guest.id}>
              <div className="avatar">{(guest.name || t('guest')).slice(0, 1).toUpperCase()}</div>
              <div>
                <strong>{guest.name || t('unnamedGuest')}</strong>
                <small>
                  {guest.active ? t('visitorOnline') : t('visitorInactive')}
                  {' · '}{t('visitorRequests', { count: guest.queueCount })}
                </small>
              </div>
              <div className="visitor-actions">
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => onKick(guest)}
                  disabled={Boolean(busy)}
                  aria-label={t('kickVisitor', { name: guest.name || t('unnamedGuest') })}
                >
                  <Trash2 size={16} />
                  <span>{t('kick')}</span>
                </button>
                <button
                  className="icon-button danger-button"
                  type="button"
                  onClick={() => onBan(guest)}
                  disabled={Boolean(busy)}
                  aria-label={t('banVisitor', { name: guest.name || t('unnamedGuest') })}
                >
                  <X size={16} />
                  <span>{t('ban')}</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">{t('noVisitors')}</p>
      )}
      <button
        className="danger-button"
        type="button"
        onClick={onKickAll}
        disabled={!guests.length || Boolean(busy)}
      >
        <Trash2 size={16} />
        {t('kickAllVisitors')}
      </button>
    </section>
  );
}

function BannedGuests({ guests = [], busy, onUnban }) {
  const { t } = useLanguage();

  return (
    <section className="panel admin-guests-panel">
      <div className="panel-title">
        <User size={18} />
        {t('bannedVisitors')}
        <span className="status-pill">{guests.length}</span>
      </div>
      {guests.length ? (
        <div className="visitor-list">
          {guests.map((guest) => (
            <div className="visitor-row" key={guest.id}>
              <div className="avatar">{(guest.name || t('unnamedGuest')).slice(0, 1).toUpperCase()}</div>
              <strong>{guest.name || t('unnamedGuest')}</strong>
              <button
                className="icon-button"
                type="button"
                onClick={() => onUnban(guest)}
                disabled={Boolean(busy)}
              >
                <span>{t('unban')}</span>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">{t('noBannedVisitors')}</p>
      )}
    </section>
  );
}

function AdminPlaybackHistory() {
  const { t } = useTranslation();
  const [history, setHistory] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [error, setError] = useState('');

  async function loadHistory() {
    setLoading(true);
    setError('');

    try {
      const result = await api.playbackHistory();
      setHistory(result.history ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function exportHistory() {
    setExporting(true);
    setError('');

    try {
      const from = exportFrom ? new Date(`${exportFrom}T00:00:00`).toISOString() : '';
      const toDate = exportTo ? new Date(`${exportTo}T00:00:00`) : null;
      if (toDate) toDate.setDate(toDate.getDate() + 1);
      const to = toDate?.toISOString() ?? '';
      const result = await api.exportPlaybackHistory({ from, to });
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    loadHistory();
  }, []);

  return (
    <section className="panel played-log-panel">
      <div className="playlist-heading">
        <div>
          <div className="panel-title">
            <ListMusic size={18} />
            {t('playedLog')}
          </div>
          <div className="muted">{t('playedLogHelp')}</div>
        </div>
        <div className="toolbar">
          <button type="button" onClick={loadHistory} disabled={loading}>
            <RefreshCcw size={16} />
            {loaded ? t('refresh') : t('loadPlayedLog')}
          </button>
          <button type="button" onClick={exportHistory} disabled={exporting}>
            <Download size={16} />
            {t('exportPlayedLog')}
          </button>
        </div>
      </div>
      <Feedback message={error} tone="error" />
      <div className="played-log-filters">
        <label>
          <span>{t('exportFromDate')}</span>
          <input
            type="date"
            value={exportFrom}
            max={exportTo || undefined}
            onChange={(event) => setExportFrom(event.target.value)}
          />
        </label>
        <label>
          <span>{t('exportToDate')}</span>
          <input
            type="date"
            value={exportTo}
            min={exportFrom || undefined}
            onChange={(event) => setExportTo(event.target.value)}
          />
        </label>
        <span className="muted">{t('exportDateHelp')}</span>
      </div>
      {history.length ? (
        <div className="track-list compact">
          {history.map((item, index) => (
            <TrackRow
              key={item.id}
              item={item}
              rank={index + 1}
              track={item.track}
              meta={`${t('playedAt')} ${formatDateTime(item.addedAt)}`}
            />
          ))}
        </div>
      ) : (
        <Feedback message={t('emptyPlayedLog')} />
      )}
    </section>
  );
}

function AdminSpotifyRequestLog() {
  const { t } = useTranslation();
  const [requests, setRequests] = useState([]);
  const [maxEntries, setMaxEntries] = useState(200);
  const [rateLimitedUntil, setRateLimitedUntil] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function loadRequestLog() {
    setLoading(true);
    setError('');
    try {
      const result = await api.spotifyRequestLog();
      setRequests(result.requests ?? []);
      setMaxEntries(result.maxEntries ?? 200);
      setRateLimitedUntil(result.rateLimitedUntil ?? null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function clearRequestLog() {
    setLoading(true);
    setError('');
    try {
      await api.clearSpotifyRequestLog();
      setRequests([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadRequestLog();
  }, []);

  return (
    <section className="panel spotify-request-log-panel">
      <div className="playlist-heading">
        <div>
          <div className="panel-title">
            <Radio size={18} />
            {t('spotifyRequestLog')}
            <span className="status-pill">{requests.length}/{maxEntries}</span>
          </div>
          <div className="muted">{t('spotifyRequestLogHelp')}</div>
          {rateLimitedUntil ? (
            <div className="muted">{t('spotifyCooldownUntil', { time: formatDateTime(rateLimitedUntil) })}</div>
          ) : null}
        </div>
        <div className="toolbar">
          <button type="button" onClick={loadRequestLog} disabled={loading}>
            <RefreshCcw size={16} />
            {t('refresh')}
          </button>
          <button type="button" onClick={clearRequestLog} disabled={loading || !requests.length}>
            <Trash2 size={16} />
            {t('clear')}
          </button>
        </div>
      </div>
      <Feedback message={error} tone="error" />
      {requests.length ? (
        <div className="spotify-request-log-wrap">
          <table className="spotify-request-log">
            <thead>
              <tr>
                <th>{t('time')}</th>
                <th>{t('request')}</th>
                <th>{t('result')}</th>
                <th>{t('duration')}</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((entry) => (
                <tr key={entry.id} className={`spotify-request-${entry.outcome}`}>
                  <td>{formatDateTime(entry.at)}</td>
                  <td><code>{entry.method} {entry.path}</code></td>
                  <td>
                    {entry.status ? `HTTP ${entry.status}` : '—'} · {t(`spotifyRequestOutcome_${entry.outcome}`)}
                    {entry.retryAfterSeconds ? ` (${entry.retryAfterSeconds}s)` : ''}
                  </td>
                  <td>{entry.durationMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Feedback message={t('emptySpotifyRequestLog')} />
      )}
    </section>
  );
}

function SpotifySetupForm({ onSaved, defaultRedirectUri }) {
  const { t } = useTranslation();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(
    defaultRedirectUri || `${window.location.origin}/api/auth/callback`
  );
  const [adminAccessKey, setAdminAccessKey] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (defaultRedirectUri) setRedirectUri(defaultRedirectUri);
  }, [defaultRedirectUri]);

  async function saveSetup(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setStatus('');

    try {
      await api.saveSpotifySetup({
        spotifyClientId: clientId,
        spotifyClientSecret: clientSecret,
        spotifyRedirectUri: redirectUri,
        frontendUrl: window.location.origin,
        adminAccessKey
      });
      setClientSecret('');
      setStatus(t('spotifySetupSaved'));
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel login-panel spotify-setup-panel">
      <div className="panel-title">{t('spotifySetupMissing')}</div>
      <Feedback message={t('spotifySetupHelp')} />
      <div className="setup-help">
        <p>{t('spotifyDashboardHelp')}</p>
        <a
          className="primary-link"
          href="https://developer.spotify.com/dashboard"
          target="_blank"
          rel="noreferrer"
        >
          {t('openSpotifyDashboard')}
        </a>
      </div>
      <form className="setup-form" onSubmit={saveSetup}>
        <label>
          <span>{t('spotifyClientId')}</span>
          <input
            value={clientId}
            onChange={(event) => setClientId(event.target.value)}
            autoComplete="off"
            required
          />
        </label>
        <label>
          <span>{t('spotifyClientSecret')}</span>
          <input
            value={clientSecret}
            onChange={(event) => setClientSecret(event.target.value)}
            autoComplete="off"
            type="password"
            required
          />
        </label>
        <label>
          <span>{t('spotifyRedirectUri')}</span>
          <input
            value={redirectUri}
            onChange={(event) => setRedirectUri(event.target.value)}
            required
          />
          <small>{t('redirectUriHelp')}</small>
        </label>
        <label>
          <span>{t('adminAccessKey')}</span>
          <input
            value={adminAccessKey}
            onChange={(event) => setAdminAccessKey(event.target.value)}
            autoComplete="new-password"
            type="password"
          />
        </label>
        <div className="muted">{t('spotifySetupLocalOnly')}</div>
        <Feedback message={error} tone="error" />
        <Feedback message={status} tone="success" />
        <button type="submit" disabled={saving}>
          {t('saveSpotifySetup')}
        </button>
      </form>
    </section>
  );
}

function HostPlaylistSetup({ host, onSaved, initialError }) {
  const { t } = useTranslation();
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [error, setError] = useState(initialError || '');
  const [saving, setSaving] = useState(false);
  const hasPlaylist = Boolean(host?.playlistId);

  async function savePlaylist(event) {
    event.preventDefault();
    setSaving(true);
    setError('');

    try {
      await api.setHostPlaylist(playlistUrl);
      setPlaylistUrl('');
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel login-panel host-playlist-panel">
      <div className="panel-title">
        {hasPlaylist ? t('hostPlaylistConfigured') : t('hostPlaylistMissing')}
      </div>
      <div className="empty-state">
        {hasPlaylist ? t('hostPlaylistConfiguredHelp') : t('hostPlaylistHelp')}
      </div>
      {hasPlaylist ? (
        <div className="setting-stack">
          <div className="setting-row">
            <span>{t('currentHostPlaylist')}</span>
            {host.playlistUrl ? (
              <a href={host.playlistUrl} target="_blank" rel="noreferrer">
                {host.playlistId}
              </a>
            ) : (
              <strong>{host.playlistId}</strong>
            )}
          </div>
          <div className="setting-row">
            <span>{t('playlistOwner')}</span>
            <strong>{host.playlistOwnerName || host.playlistOwnerId || '-'}</strong>
          </div>
        </div>
      ) : null}
      <Feedback message={error} tone="error" />
      <form className="inline-form" onSubmit={savePlaylist}>
        <input
          value={playlistUrl}
          onChange={(event) => setPlaylistUrl(event.target.value)}
          placeholder={t('hostPlaylistPlaceholder')}
          required
        />
        <button type="submit" disabled={saving}>
          {t('saveHostPlaylist')}
        </button>
      </form>
    </section>
  );
}

function InviteAdminPanel({ invite, onSaved, onCopied }) {
  const { t } = useTranslation();
  const [pin, setPin] = useState('');
  const [pinEnabled, setPinEnabled] = useState(false);
  const [guestsCanInvite, setGuestsCanInvite] = useState(true);
  const [playlistLinksEnabled, setPlaylistLinksEnabled] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPinEnabled(Boolean(invite?.pinEnabled));
    setGuestsCanInvite(Boolean(invite?.guestsCanInvite));
    setPlaylistLinksEnabled(invite?.playlistLinksEnabled !== false);
  }, [invite?.pinEnabled, invite?.guestsCanInvite, invite?.playlistLinksEnabled]);

  async function saveInvite(event) {
    event.preventDefault();
    setSaving(true);
    setError('');

    try {
      await api.saveInviteSettings({
        ...(pin.trim() ? { pin } : {}),
        pinEnabled: pin.trim() ? true : pinEnabled,
        guestsCanInvite,
        playlistLinksEnabled
      });
      setPin('');
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function rotateInvite() {
    setSaving(true);
    setError('');

    try {
      await api.rotateInvite();
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel invite-admin-panel">
      <div className="panel-title">{t('inviteSettings')}</div>
      <Feedback message={t('inviteAdminHelp')} />
      <InviteQrPanel
        inviteUrl={invite?.inviteUrl}
        canInvite
        onCopied={onCopied}
      />
      <form className="setup-form" onSubmit={saveInvite}>
        <label>
          <span>{t('invitePin')}</span>
          <input
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            placeholder={invite?.pinConfigured ? t('pinAlreadySet') : t('invitePinPlaceholder')}
            inputMode="numeric"
            autoComplete="new-password"
          />
          <small>{t('invitePinAdminHelp')}</small>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={pinEnabled}
            disabled={!invite?.pinConfigured && !pin.trim()}
            onChange={(event) => setPinEnabled(event.target.checked)}
          />
          <span>{t('pinEnabled')}</span>
          <small>{t('pinEnabledHelp')}</small>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={guestsCanInvite}
            onChange={(event) => setGuestsCanInvite(event.target.checked)}
          />
          <span>{t('guestsCanInvite')}</span>
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={playlistLinksEnabled}
            onChange={(event) => setPlaylistLinksEnabled(event.target.checked)}
          />
          <span>{t('playlistLinksEnabled')}</span>
        </label>
        <Feedback message={error} tone="error" />
        <div className="toolbar">
          <button type="submit" disabled={saving}>
            {t('saveInviteSettings')}
          </button>
          <button type="button" onClick={rotateInvite} disabled={saving}>
            {t('rotateInvite')}
          </button>
        </div>
      </form>
    </section>
  );
}

function AdminAccessGate({ onUnlocked }) {
  const { t } = useTranslation();
  const [accessKey, setAccessKey] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .adminAccessStatus()
      .then(() => {
        onUnlocked();
      })
      .catch(() => {
        api.unlockAdmin('').then(onUnlocked).catch(() => {});
      });
  }, [onUnlocked]);

  async function unlock(event) {
    event.preventDefault();
    setError('');

    try {
      await api.unlockAdmin(accessKey);
      onUnlocked();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="app-shell admin-shell">
      <header className="topbar">
        <div>
          <div className="brand">EasyJAM Admin</div>
          <div className="muted">{t('adminAccessHelp')}</div>
        </div>
        <a className="ghost-link" href="/">
          {t('guestLink')}
        </a>
      </header>
      <section className="panel login-panel">
        <form className="setup-form" onSubmit={unlock}>
          <label>
            <span>{t('adminAccessPrompt')}</span>
            <input
              value={accessKey}
              onChange={(event) => setAccessKey(event.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </label>
          <Feedback message={error} tone="error" />
          <button type="submit">{t('unlockAdmin')}</button>
        </form>
      </section>
    </div>
  );
}

function AdminApp() {
  const { t, toggleLanguage } = useLanguage();
  const [status, setStatus] = useState(null);
  const [queue, setQueue] = useState([]);
  const [current, setCurrent] = useState(null);
  const [pinInput, setPinInput] = useState('');
  const [selectedPinnedPlaylist, setSelectedPinnedPlaylist] = useState(null);
  const [error, setError] = useState('');
  const [syncResult, setSyncResult] = useState(null);
  const [busyAction, setBusyAction] = useState('');
  const [oauthSetupError, setOauthSetupError] = useState('');
  const [showSpotifySetup, setShowSpotifySetup] = useState(() => {
    const url = new URL(window.location.href);
    return url.searchParams.get('setup') === 'spotify';
  });
  const [accessUnlocked, setAccessUnlocked] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('adminToken');
    if (token) {
      setAdminToken(token);
      url.searchParams.delete('adminToken');
    }
    if (url.searchParams.get('auth') === 'success' && !token && !getAdminToken()) {
      setError(t('adminTokenMissing'));
    }
    const spotifyError = url.searchParams.get('spotifyError');
    if (spotifyError) {
      setOauthSetupError(spotifyError);
      url.searchParams.delete('spotifyError');
    }
    if (url.searchParams.get('auth') === 'partial') {
      setError(t('spotifyPartialAuth'));
      url.searchParams.delete('auth');
    }
    if (url.searchParams.get('setup') === 'spotify') {
      setShowSpotifySetup(true);
      url.searchParams.delete('setup');
    }
    window.history.replaceState({}, '', url.toString());
  }, []);

  const refresh = useSingleFlightCallback(async () => {
    if (!getAdminToken()) {
      const session = await api.session();
      setStatus(session);
      setQueue(session.queue ?? []);
      setError('');
      return;
    }

    let statusResult;
    try {
      statusResult = await api.adminStatus();
    } catch (err) {
      if (err.status !== 401) throw err;

      clearAdminToken();
      const session = await api.session();
      setStatus(session);
      setQueue(session.queue ?? []);
      setCurrent(null);
      setError('');
      return;
    }

    const shouldPollPlayback =
      statusResult.host?.authenticated && statusResult.host?.playlistId;
    const currentResult = shouldPollPlayback
      ? await api.current()
      : { current: null };
    const nextStatus = currentResult.playbackUpdate?.removedItem
      ? await api.adminStatus()
      : statusResult;

    setStatus(nextStatus);
    setQueue(nextStatus.queue ?? []);
    setCurrent(currentResult.playbackUnavailable ? { unavailable: true } : currentResult.current);
    setError('');
  });

  usePolling(() => {
    refresh().catch((err) => setError(err.message));
  }, accessUnlocked ? 5000 : null);

  async function runAdminAction(actionName, action) {
    setBusyAction(actionName);
    setError('');

    try {
      const result = await action();
      await refresh();
      setSyncResult(result?.spotifySync ?? null);
      if (result?.spotifySync?.error) {
        const syncError = result.spotifySync.error;
        const details = formatErrorDetails(syncError.details);
        const status = syncError.status ? `HTTP ${syncError.status}` : '';
        setError([syncError.message, status, details].filter(Boolean).join(' · '));
      }
      return result;
    } catch (err) {
      if (err.status === 401) {
        clearAdminToken();
      }
      const detailsText = formatErrorDetails(err.details);
      setError(detailsText ? `${err.message}: ${detailsText}` : err.message);
      return null;
    } finally {
      setBusyAction('');
    }
  }

  async function removeAny(itemId) {
    const result = await runAdminAction('remove', () => api.removeAny(itemId));
    if (result?.queue) setQueue(result.queue);
  }

  async function kickGuest(guest) {
    const name = guest.name || t('unnamedGuest');
    if (!window.confirm(t('kickVisitorConfirm', { name }))) return;
    const result = await runAdminAction('kickGuest', () => api.removeGuest(guest.id));
    if (result?.queue) setQueue(result.queue);
  }

  async function kickAllGuests() {
    if (!window.confirm(t('kickAllVisitorsConfirm'))) return;
    const result = await runAdminAction('kickAllGuests', () => api.removeAllGuests());
    if (result?.queue) setQueue(result.queue);
  }

  async function banGuest(guest) {
    const name = guest.name || t('unnamedGuest');
    if (!window.confirm(t('banVisitorConfirm', { name }))) return;
    const result = await runAdminAction('banGuest', () => api.banGuest(guest.id));
    if (result?.queue) setQueue(result.queue);
  }

  async function unbanGuest(guest) {
    await runAdminAction('unbanGuest', () => api.unbanGuest(guest.id));
  }

  async function applyQueueMode() {
    const result = await runAdminAction('applyQueueMode', () => api.resetOrder());
    if (result?.queue) setQueue(result.queue);
  }

  async function setQueueMode(queueMode) {
    const result = await runAdminAction('queueMode', () => api.setQueueMode(queueMode));
    if (result?.queue) setQueue(result.queue);
  }

  async function resetLeaderboard() {
    if (!window.confirm(t('resetLeaderboardConfirm'))) return;
    await runAdminAction('leaderboard', () => api.resetLeaderboard());
  }

  async function sync() {
    await runAdminAction('sync', () => api.sync());
  }

  async function startPlayback() {
    await runAdminAction('playback', () => api.startPlayback());
  }

  async function setRandomFallback(enabled) {
    await runAdminAction(
      'randomFallback',
      () => api.setRandomFallback(enabled)
    );
  }

  async function setAutoPlayback(enabled) {
    await runAdminAction(
      'autoPlayback',
      () => api.setAutoPlayback(enabled)
    );
  }

  async function setHandoffLead(handoffLeadMs) {
    await runAdminAction(
      'handoffLead',
      () => api.setHandoffLead(handoffLeadMs)
    );
  }

  async function pinPlaylist(event) {
    event.preventDefault();
    setError('');
    try {
      await api.pinPlaylist(pinInput);
      setPinInput('');
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function removePinned(playlistId) {
    await api.removePinned(playlistId);
    await refresh();
  }

  async function refreshPinnedPlaylists() {
    await runAdminAction('refreshPinnedPlaylists', () => api.refreshPinnedPlaylists());
  }

  async function setPinnedFallback(playlistId, enabled) {
    await runAdminAction(
      `pinnedFallback-${playlistId}`,
      () => api.setPinnedFallback(playlistId, enabled)
    );
  }

  async function setPinnedGuestVisibility(playlistId, visibleToGuests) {
    await runAdminAction(
      `pinnedVisibility-${playlistId}`,
      () => api.setPinnedGuestVisibility(playlistId, visibleToGuests)
    );
  }

  const authenticated = status?.host?.authenticated && getAdminToken();
  const spotifyConfigured = status?.host?.spotifyConfigured;

  if (!accessUnlocked) {
    return <AdminAccessGate onUnlocked={() => setAccessUnlocked(true)} />;
  }

  return (
    <div className="app-shell admin-shell">
      <header className="topbar">
        <div>
          <div className="brand">EasyJAM Admin</div>
          <div className="muted">
            {status?.host?.authenticated ? t('hostConnected') : t('hostMissing')}
          </div>
        </div>
        <div className="topbar-actions">
          <a className="ghost-link" href="/">
            {t('guestLink')}
          </a>
          <button
            className="icon-button"
            type="button"
            onClick={toggleLanguage}
            aria-label={t('changeLanguage')}
          >
            <Globe2 size={17} aria-hidden="true" />
            <span>{t('language')}</span>
          </button>
        </div>
      </header>

      {!authenticated && (spotifyConfigured === false || showSpotifySetup) ? (
        <SpotifySetupForm
          defaultRedirectUri={status?.host?.spotifyRedirectUri}
          onSaved={async () => {
            setShowSpotifySetup(false);
            await refresh();
          }}
        />
      ) : null}

      {!authenticated && spotifyConfigured !== false && !showSpotifySetup ? (
        <section className="panel login-panel">
          <a className="primary-link" href="/api/auth/login">
            {t('connectSpotify')}
          </a>
          <button
            className="ghost-link"
            type="button"
            onClick={() => setShowSpotifySetup(true)}
          >
            {t('editSpotifySetup')}
          </button>
        </section>
      ) : null}

      <Feedback message={error} tone="error" />
      {syncResult && !syncResult.error ? (
        <div className="sync-state">
          <span>
            {t('syncStatusCount')}: {syncResult.count ?? 0}
          </span>
          {syncResult.verifiedTotal !== null && syncResult.verifiedTotal !== undefined ? (
            <span>
              {t('syncStatusVerified')}: {syncResult.verifiedTotal}
            </span>
          ) : null}
          {syncResult.snapshotId ? (
            <span>
              {t('syncStatusSnapshot')}: {syncResult.snapshotId}
            </span>
          ) : null}
          {syncResult.source ? (
            <span>
              {t('syncStatusSource')}: {t(`syncSource_${syncResult.source}`)}
            </span>
          ) : null}
        </div>
      ) : null}
      {authenticated ? (
        <>
        <CurrentTrack
          current={current}
          isPlaybackPaused={Boolean(!current?.track && status?.sync?.manualPause)}
          isPlaybackUnavailable={Boolean(current?.unavailable)}
          queueCount={queue.length}
        />
        <div className="admin-workspace">
          <div className="admin-side">
          <HostPlaylistSetup
            host={status?.host}
            onSaved={refresh}
            initialError={!status?.host?.playlistId ? oauthSetupError : ''}
          />

          <InviteAdminPanel
            invite={status?.invite}
            onSaved={refresh}
            onCopied={() => {}}
          />
          </div>

          <div className="admin-main">
          <AdminGuests
            guests={status?.guests}
            busy={busyAction}
            onKick={kickGuest}
            onKickAll={kickAllGuests}
            onBan={banGuest}
          />
          <BannedGuests
            guests={status?.bannedGuests}
            busy={busyAction}
            onUnban={unbanGuest}
          />
          <section className="panel host-controls">
            <div className="panel-title">
              <Settings size={18} />
              {t('hostControls')}
            </div>
            <div className="toolbar">
            <button
              type="button"
              onClick={sync}
              disabled={Boolean(busyAction)}
            >
              <RefreshCcw size={16} />
              {t('sync')}
            </button>
            <button
              type="button"
              onClick={startPlayback}
              disabled={Boolean(busyAction)}
            >
              <Play size={16} />
              {t('startPlayback')}
            </button>
            <button
              type="button"
              onClick={applyQueueMode}
              className="apply-queue-mode-button"
              disabled={Boolean(busyAction)}
            >
              <Lock size={16} />
              {t('applyQueueMode')}
            </button>
            <button
              type="button"
              onClick={resetLeaderboard}
              disabled={Boolean(busyAction)}
            >
              <Trash2 size={16} />
              {t('resetLeaderboard')}
            </button>
            {status?.manualOrderActive ? (
              <span className="status-pill">{t('manualLocked')}</span>
            ) : null}
            </div>
            <label className="setting-row">
              <span>
                <strong>{t('queueMode')}</strong>
                <small>{t('queueModeHelp')}</small>
              </span>
              <select
                value={status?.queueMode ?? 'roundRobin'}
                onChange={(event) => setQueueMode(event.target.value)}
                disabled={Boolean(busyAction)}
              >
                <option value="roundRobin">{t('queueModeRoundRobin')}</option>
                <option value="fifo">{t('queueModeFifo')}</option>
              </select>
            </label>
            <label className="setting-row">
              <span>
                <strong>{t('randomFallback')}</strong>
                <small>{t('randomFallbackHelp')}</small>
              </span>
              <input
                type="checkbox"
                checked={Boolean(status?.randomFallback?.enabled)}
                onChange={(event) => setRandomFallback(event.target.checked)}
                disabled={Boolean(busyAction)}
              />
            </label>
            <label className="setting-row">
              <span>
                <strong>{t('autoPlayback')}</strong>
                <small>{t('autoPlaybackHelp')}</small>
              </span>
              <input
                type="checkbox"
                checked={Boolean(status?.host?.autoStartPlayback)}
                onChange={(event) => setAutoPlayback(event.target.checked)}
                disabled={Boolean(busyAction)}
              />
            </label>
            <label className="setting-row setting-row-range">
              <span>
                <strong>{t('handoffLead')}</strong>
                <small>{t('handoffLeadHelp')}</small>
              </span>
              <span className="range-control">
                <output>{`-${((status?.host?.handoffLeadMs ?? 2000) / 1000).toFixed(1)} s`}</output>
                <input
                  type="range"
                  min="-10000"
                  max="0"
                  step="500"
                  value={-(status?.host?.handoffLeadMs ?? 2000)}
                  onChange={(event) => setHandoffLead(-Number(event.target.value))}
                  disabled={Boolean(busyAction)}
                />
              </span>
            </label>
          </section>

          <section className="panel admin-queue-panel">
            <div className="panel-title">
              <ListMusic size={18} />
              {t('queue')}
            </div>
            <AdminQueue queue={queue} setQueue={setQueue} onRemove={removeAny} />
          </section>

          <AdminPlaybackHistory />

          <AdminSpotifyRequestLog />

          <section className="panel pinned-panel">
            <div className="playlist-heading">
              <div className="panel-title">
                <ListMusic size={18} />
                {t('pinnedPlaylists')}
              </div>
              <button
                type="button"
                onClick={refreshPinnedPlaylists}
                disabled={Boolean(busyAction)}
              >
                <RefreshCcw size={16} />
                {t('refresh')}
              </button>
            </div>
            <form className="inline-form" onSubmit={pinPlaylist}>
              <input
                value={pinInput}
                onChange={(event) => setPinInput(event.target.value)}
                placeholder={t('playlistPlaceholder')}
              />
              <button type="submit">
                <Plus size={16} />
                {t('addPinned')}
              </button>
            </form>
            {status?.pinnedPlaylists?.length ? (
              <div className="playlist-table-wrap pinned-playlist-table-wrap">
                <table className="playlist-table pinned-playlist-table">
                  <thead>
                    <tr>
                      <th>{t('pinnedPlaylist')}</th>
                      <th>{t('playlistOwner')}</th>
                      <th>{t('trackCount')}</th>
                      <th>{t('useAsFallback')}</th>
                      <th>{t('visibleToGuests')}</th>
                      <th aria-label={t('remove')} />
                    </tr>
                  </thead>
                  <tbody>
                    {status.pinnedPlaylists.map((playlist) => (
                      <tr key={playlist.id}>
                        <td className="playlist-track-name">
                          <button
                            className="pinned-playlist-select"
                            type="button"
                            onClick={() => setSelectedPinnedPlaylist(playlist)}
                          >
                            <span className="playlist-track-name-content">
                              {playlist.image ? <img src={playlist.image} alt="" /> : null}
                              <span>{playlist.name}</span>
                            </span>
                          </button>
                        </td>
                        <td>{playlist.owner || '—'}</td>
                        <td>{playlist.trackTotal ?? '—'}</td>
                        <td>
                          <input
                            className="pinned-fallback-toggle"
                            type="checkbox"
                            checked={playlist.fallbackEnabled !== false}
                            onChange={(event) => setPinnedFallback(playlist.id, event.target.checked)}
                            disabled={Boolean(busyAction)}
                            aria-label={t('useAsFallbackFor', { name: playlist.name })}
                          />
                        </td>
                        <td>
                          <input
                            className="pinned-fallback-toggle"
                            type="checkbox"
                            checked={playlist.visibleToGuests !== false}
                            onChange={(event) => setPinnedGuestVisibility(playlist.id, event.target.checked)}
                            disabled={Boolean(busyAction)}
                            aria-label={t('visibleToGuestsFor', { name: playlist.name })}
                          />
                        </td>
                        <td>
                          <button
                            className="icon-button pinned-playlist-remove"
                            type="button"
                            onClick={() => removePinned(playlist.id)}
                            disabled={Boolean(busyAction)}
                            aria-label={t('remove')}
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
          <PlaylistBrowser
            playlist={selectedPinnedPlaylist}
            admin
          />
          </div>
        </div>
        </>
      ) : null}
    </div>
  );
}

export default function App() {
  if (window.location.pathname.startsWith('/tv')) return <TvDisplay />;
  const isAdmin = window.location.pathname.startsWith('/admin');
  return isAdmin ? <AdminApp /> : <GuestApp />;
}
