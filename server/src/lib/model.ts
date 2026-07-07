// Aerie shared contract — types used by both server and web.
// This is the load-bearing interface. Feature agents build against these.

export type Role = 'admin' | 'user';

export interface UserFeatures {
  audiobooks?: boolean;
}

export interface User {
  id: number;
  username: string;
  displayName: string;
  email: string | null;
  role: Role;
  avatarColor: string;
  avatarUrl: string | null;         // uploaded profile picture, or null (use colour+initials)
  storageQuotaBytes: number | null; // null = unlimited
  aiMode: AiMode;
  features?: UserFeatures;
  createdAt: string;
}

export type AiMode = 'local_only' | 'ask_before_send' | 'external_allowed' | 'disabled';

export interface AuthResponse {
  token: string;
  user: User;
}

// ---------- Files ----------
export type FileKind =
  | 'folder' | 'text' | 'markdown' | 'document' | 'spreadsheet' | 'csv'
  | 'pdf' | 'image' | 'video' | 'audio' | 'archive' | 'code' | 'other';

export interface FileEntry {
  id: string;            // opaque id (relative path encoded)
  name: string;
  path: string;          // POSIX path relative to user root, e.g. /Documents/notes.md
  parent: string;        // parent path
  kind: FileKind;
  mime: string;
  size: number;          // bytes; 0 for folders
  modifiedAt: string;    // ISO
  createdAt: string;     // ISO
  isFolder: boolean;
  starred: boolean;
  thumbUrl?: string;     // if previewable
  itemCount?: number;    // for folders
}

export interface FileListing {
  path: string;
  parent: string | null;
  breadcrumbs: { name: string; path: string }[];
  entries: FileEntry[];
}

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number | null;
  fileCount: number;
  byKind: Record<string, { count: number; bytes: number }>;
}

// ---------- Media (Jellyfin-backed) ----------
export interface MediaItem {
  id: string;
  type: 'Movie' | 'Series' | 'Season' | 'Episode' | 'Audio' | 'MusicAlbum' | 'MusicArtist';
  name: string;
  overview?: string;
  year?: number;
  posterUrl?: string;
  backdropUrl?: string;
  thumbUrl?: string;
  runtimeTicks?: number;
  runtimeMinutes?: number;
  progressPct?: number;   // continue watching/listening
  playedPct?: number;
  positionTicks?: number;
  played?: boolean;
  seriesId?: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  albumArtist?: string;
  album?: string;
  genres?: string[];
  communityRating?: number;
}

export interface StreamInfo {
  streamUrl: string;      // direct/HLS url proxied through Aerie
  hls: boolean;
  mime: string;
  posterUrl?: string;
  positionTicks?: number;
}

// ---------- Photos ----------
export interface NativePhoto {
  path: string;
  takenAt: string | null;
  width: number | null;
  height: number | null;
  size: number;
  camera: string | null;
  lat: number | null;
  lon: number | null;
}

// ---------- Audiobooks / Podcasts (Audiobookshelf-backed) ----------
export interface Book {
  id: string;
  libraryItemId: string;
  title: string;
  author?: string;
  narrator?: string;
  series?: string;
  coverUrl?: string;
  durationSec?: number;
  progressPct?: number;
  currentTimeSec?: number;
  numChapters?: number;
  mediaType: 'book' | 'podcast';
}

export interface Chapter { id: number; title: string; start: number; end: number; }

// ---------- Documents & Spreadsheets ----------
export interface DocMeta {
  id: string;
  path: string;
  title: string;
  updatedAt: string;
  kind: 'document' | 'spreadsheet';
}

export interface DocVersion {
  id: string;
  createdAt: string;
  author: string;
  note?: string;
  sizeBytes: number;
}

// ---------- AI ----------
export interface AiJob {
  id: string;
  type: 'image' | 'transcribe' | 'ocr' | 'thumbnail' | 'summarize' | 'assistant';
  status: 'queued' | 'running' | 'done' | 'error';
  prompt?: string;
  progress?: number;      // 0..1
  createdAt: string;
  finishedAt?: string;
  resultUrls?: string[];
  error?: string;
}

export interface AiChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AiSuggestion {
  original: string;
  suggestion: string;
  action: string;
}

export interface GeneratedImage {
  id: string;
  prompt: string;
  url: string;
  thumbUrl: string;
  createdAt: string;
  width: number;
  height: number;
  workflow: string;
}

// ---------- Sharing ----------
export interface Share {
  id: string;
  path: string;
  name: string;
  type: 'link' | 'user';
  permission: 'view' | 'edit';
  allowDownload: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  url: string | null;
  sharedWith?: string;
  createdAt: string;
}

// ---------- Admin / Monitoring ----------
export interface ServiceStatus {
  key: string;
  name: string;
  online: boolean;
  latencyMs?: number;
  detail?: string;
  url?: string;
}

export interface SystemHealth {
  cpuPct: number;
  memUsedGb: number;
  memTotalGb: number;
  gpuName?: string;
  gpuMemUsedMb?: number;
  gpuMemTotalMb?: number;
  gpuUtilPct?: number;
  storageUsedTb: number;
  storageTotalTb: number;
  uptimeSec: number;
  loadAvg: number[];
}

export interface BackupStatus {
  key: string;
  name: string;
  lastRun: string | null;
  success: boolean;
  sizeBytes?: number;
  nextRun?: string | null;
  note?: string;
}

export interface AuditEvent {
  id: number;
  ts: string;
  userId: number | null;
  username: string;
  action: string;
  target?: string;
  ip?: string;
  meta?: Record<string, unknown>;
}

export interface Device {
  id: string;
  name: string;
  type: 'phone' | 'desktop' | 'tablet' | 'web';
  lastSeen: string;
  backupStatus?: string;
  trusted: boolean;
}

export interface Automation {
  id: string;
  name: string;
  trigger: string;
  action: string;
  enabled: boolean;
  lastRun?: string;
  runCount: number;
}

export interface Notification {
  id: string;
  ts: string;
  title: string;
  body?: string;
  level: 'info' | 'success' | 'warning' | 'error';
  read: boolean;
  link?: string;
}

// ---------- Dashboard ----------
export interface DashboardData {
  storage: StorageUsage;
  recentFiles: FileEntry[];
  recentPhotos: NativePhoto[];
  continueWatching: MediaItem[];
  continueListening: Book[];
  aiJobs: AiJob[];
  generatedImages: GeneratedImage[];
  backups: BackupStatus[];
  health: SystemHealth;
  services: ServiceStatus[];
  devices: Device[];
  phoneBackup: { lastBackup: string | null; pending: number; status: string };
  notifications: Notification[];
}

// ---------- Universal Search ----------
export interface SearchResult {
  id: string;
  kind: string;        // 'file' | 'photo' | 'movie' | 'song' | 'book' | ...
  title: string;
  subtitle?: string;
  thumbUrl?: string;
  link: string;        // in-app route
}

export interface SearchResponse {
  query: string;
  groups: { kind: string; label: string; results: SearchResult[] }[];
}
