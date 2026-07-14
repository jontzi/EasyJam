import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { errorHandler, router } from './routes.js';
import { maintainSpotifyPlayback, refreshPinnedPlaylists } from './spotify.js';
import { initStorage, savePinnedPlaylists } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.resolve(__dirname, '../../client/dist');

const app = express();
app.set('trust proxy', true);

app.use(
  cors({
    origin: config.frontendUrl,
    credentials: true
  })
);
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

app.use('/api', router);
app.use(express.static(clientDist));
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.use(errorHandler);

await initStorage();

setInterval(() => {
  maintainSpotifyPlayback().catch((error) => {
    console.warn(`EasyJam Spotify playback maintenance failed: ${error.message}`);
  });
}, 5_000).unref();

setInterval(() => {
  refreshPinnedPlaylists()
    .then((result) => (result.changed ? savePinnedPlaylists() : null))
    .catch((error) => {
      console.warn(`EasyJam pinned-playlist refresh failed: ${error.message}`);
    });
}, 60_000).unref();

app.listen(config.port, () => {
  console.log(`EasyJam server listening on http://localhost:${config.port}`);
});
