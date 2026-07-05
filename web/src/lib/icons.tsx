// Inline SVG icon set (no external dependency, CSP-safe). Stroke-based, 1.75px.
import React from 'react';

type P = React.SVGProps<SVGSVGElement> & { size?: number };
const Ic = (path: React.ReactNode) => ({ size = 20, ...p }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...p}>{path}</svg>
);

export const Icon = {
  Dashboard: Ic(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>),
  Files: Ic(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>),
  Folder: Ic(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>),
  Photos: Ic(<><rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m3 16 4-4 4 4 4-5 6 6" /></>),
  Video: Ic(<><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 9 4-2v10l-4-2z" /></>),
  Movie: Ic(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v5M16 4v5M8 15h8" /></>),
  TV: Ic(<><rect x="2" y="5" width="20" height="13" rx="2" /><path d="m8 21 4-3 4 3" /></>),
  Music: Ic(<><circle cx="7" cy="17" r="3" /><circle cx="18" cy="15" r="3" /><path d="M10 17V5l11-2v12" /></>),
  Book: Ic(<><path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v16H6.5A2.5 2.5 0 0 0 4 20.5z" /><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v4H6.5A2.5 2.5 0 0 1 4 20.5z" /></>),
  Podcast: Ic(<><circle cx="12" cy="10" r="3" /><path d="M8.5 15.5a5 5 0 1 1 7 0M6 18a8 8 0 1 1 12 0M12 13v8" /></>),
  Doc: Ic(<><path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" /><path d="M14 2v5h5M8 13h8M8 17h6" /></>),
  Sheet: Ic(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>),
  Image: Ic(<><rect x="3" y="3" width="18" height="18" rx="2.5" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m3 16 4-4 4 4 4-5 6 6" /></>),
  Edit: Ic(<><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>),
  Sparkles: Ic(<><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" /><path d="M19 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></>),
  Robot: Ic(<><rect x="4" y="8" width="16" height="12" rx="2.5" /><path d="M12 8V4M9 2h6" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" /><path d="M2 13v3M22 13v3" /></>),
  Bolt: Ic(<><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></>),
  Backup: Ic(<><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7" /><path d="M4 7c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3z" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>),
  Monitor: Ic(<><path d="M3 12h4l2 5 4-12 2 7h6" /></>),
  Shield: Ic(<><path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" /></>),
  Admin: Ic(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" /></>),
  Settings: Ic(<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>),
  Search: Ic(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>),
  Bell: Ic(<><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></>),
  Upload: Ic(<><path d="M12 15V3m-4 4 4-4 4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>),
  Download: Ic(<><path d="M12 3v12m-4-4 4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>),
  Plus: Ic(<><path d="M12 5v14M5 12h14" /></>),
  Grid: Ic(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>),
  List: Ic(<><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>),
  Star: ({ size = 20, filled, ...p }: P & { filled?: boolean }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18l-5.8 3.4 1.1-6.5L2.6 9.8l6.5-.9z" /></svg>
  ),
  Trash: Ic(<><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" /></>),
  Share: Ic(<><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" /></>),
  More: Ic(<><circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" /></>),
  Play: ({ size = 20, ...p }: P) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 7 4.5z" /></svg>),
  Pause: ({ size = 20, ...p }: P) => (<svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...p}><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>),
  Next: Ic(<><path d="M5 5v14l9-7zM19 5v14" /></>),
  Prev: Ic(<><path d="M19 5v14l-9-7zM5 5v14" /></>),
  Shuffle: Ic(<><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></>),
  Repeat: Ic(<><path d="m17 2 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" /></>),
  Volume: Ic(<><path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></>),
  Close: Ic(<><path d="M18 6 6 18M6 6l12 12" /></>),
  Check: Ic(<><path d="M20 6 9 17l-5-5" /></>),
  ChevronRight: Ic(<><path d="m9 6 6 6-6 6" /></>),
  ChevronLeft: Ic(<><path d="m15 6-6 6 6 6" /></>),
  ChevronDown: Ic(<><path d="m6 9 6 6 6-6" /></>),
  Menu: Ic(<><path d="M3 6h18M3 12h18M3 18h18" /></>),
  Logout: Ic(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></>),
  Device: Ic(<><rect x="5" y="2" width="14" height="20" rx="2.5" /><path d="M11 18h2" /></>),
  Desktop: Ic(<><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>),
  Phone: Ic(<><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M10.5 18h3" /></>),
  Clock: Ic(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
  Cloud: Ic(<><path d="M7 18a5 5 0 0 1-1-9.9A6 6 0 0 1 18 8a4.5 4.5 0 0 1-1 9z" /></>),
  // Aerie brand mark — a sword planted in a mountain range.
  Logo: Ic(<><path d="M2 20 L8.5 9 L12 14 L15.5 8 L22 20 Z" /><path d="M12 2.5 V17.5" /><path d="M9.4 14 H14.6" /><circle cx="12" cy="19" r="1.1" /></>),
  Info: Ic(<><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></>),
  Warning: Ic(<><path d="M12 3 2 20h20zM12 9v5M12 17h.01" /></>),
  Wifi: Ic(<><path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01" /></>),
  Cpu: Ic(<><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2" /></>),
  Copy: Ic(<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>),
  Eye: Ic(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>),
  Link: Ic(<><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></>),
  Refresh: Ic(<><path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" /></>),
  Filter: Ic(<><path d="M3 5h18l-7 8v6l-4-2v-4z" /></>),
  Heart: ({ size = 20, filled, ...p }: P & { filled?: boolean }) => (<svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M12 21C5.5 16.5 3 13 3 9a4.5 4.5 0 0 1 9-1 4.5 4.5 0 0 1 9 1c0 4-2.5 7.5-9 12z" /></svg>),
  Send: Ic(<><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></>),
  Crop: Ic(<><path d="M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14" /></>),
};

export type IconName = keyof typeof Icon;
