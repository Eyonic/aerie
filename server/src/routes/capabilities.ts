import { Router } from 'express';
import type { AuthedRequest } from '../lib/auth.js';
import { config } from '../config.js';
import { getSetting } from '../lib/db.js';
import * as jellyfin from '../services/jellyfin.js';
import * as audiobookshelf from '../services/audiobookshelf.js';
import * as jellyseerr from '../services/jellyseerr.js';
import * as lidarr from '../services/lidarr.js';

const router = Router();

// Configuration-aware product capabilities. This intentionally reports
// whether a feature is set up, not whether an optional service happens to be
// reachable at this exact second; a brief outage must not rearrange navigation.
router.get('/', (req: AuthedRequest, res) => {
  const externalAiAllowed = getSetting('external_ai', 'false') === 'true'
    && req.user?.aiMode !== 'local_only' && req.user?.aiMode !== 'disabled';
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.json({
    mediaLibrary: jellyfin.configured(),
    audiobookLibrary: audiobookshelf.configured(),
    mediaRequests: jellyseerr.configured(),
    musicRequests: lidarr.configured(),
    assistant: req.user?.aiMode !== 'disabled' && (!!config.ollama.url || (externalAiAllowed && !!config.deepseek.apiKey)),
    imageGeneration: !!config.sd.url,
    musicGeneration: !!config.acestep.url,
    transcription: !!config.whisper.url,
  });
});

export default router;
