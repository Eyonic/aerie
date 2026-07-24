import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import { Icon } from '../lib/icons';
import { pwa } from '../lib/pwa';
import { formatBytes, cx } from '../lib/utils';
import { PageHeader, Badge, Spinner } from '../components/ui';
import { toast } from '../lib/store';

type Plat = {
  key: string; label: string; kind: string; available: boolean; url: string | null;
  filename: string | null; sizeBytes: number; sha256: string | null; version: string | null;
  build: number | null; certificateSha256: string | null; minServerVersion: string | null;
  publishedAt: string | null; notes: string | null; signatureAlgorithm: string | null;
  signatureKeyId: string | null; signature: string | null; verified: boolean; signatureVerified: boolean;
};

type DesktopUpdateState = {
  platform: string;
  currentVersion: string;
  currentBuild: number;
  checking: boolean;
  canRollback: boolean;
  lastCheckAt: number | null;
};

// The Android build is a lightweight WebView client that wraps the Aerie web app.
const isWebViewApk = (p: Plat) => p.key === 'android' && p.available && p.sizeBytes < 1_000_000;

// Absolute, TOKENLESS download URL. The /downloads/* installers are served as public
// static files (a browser download can't send auth headers), so the QR must point at the
// plain path — embedding the logged-in user's ?token=… would leak their credentials to
// anyone who scans the code.
function absUrl(path: string): string {
  try { return new URL(path, window.location.origin).href; } catch { return path; }
}

// Scannable QR code for a download link.
function QrCode({ url }: { url: string }) {
  const [data, setData] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' })
      .then(d => { if (alive) setData(d); })
      .catch(() => { if (alive) setData(''); });
    return () => { alive = false; };
  }, [url]);
  return (
    <div className="mt-3 flex items-center gap-3">
      <div className="w-[76px] h-[76px] rounded-lg bg-white p-1 grid place-items-center shrink-0">
        {data ? <img src={data} alt="Scan to download" className="w-full h-full" /> : <Spinner size={16} />}
      </div>
      <p className="text-[11px] text-slate-500 leading-snug">Scan with your phone to download directly.</p>
    </div>
  );
}

function detectOS(): string {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/win/i.test(ua)) return 'windows';
  if (/linux/i.test(ua)) return 'linux';
  if (/mac/i.test(ua)) return 'mac';
  return 'other';
}

const ICON: Record<string, React.ReactNode> = {
  windows: <Icon.Desktop size={26} />, linux: <Icon.Desktop size={26} />, 'linux-deb': <Icon.Desktop size={26} />,
  android: <Icon.Phone size={26} />, pwa: <Icon.Cloud size={26} />,
};

export default function GetApps() {
  const [plats, setPlats] = useState<Plat[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [canInstall, setCanInstall] = useState(pwa.canInstall());
  const [standalone] = useState(pwa.isStandalone());
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateState | null>(null);
  const [desktopUpdateBusy, setDesktopUpdateBusy] = useState(false);
  const [desktopUpdateProgress, setDesktopUpdateProgress] = useState<{ receivedBytes: number; totalBytes: number } | null>(null);
  const [nativeBuild] = useState<number | null>(() => {
    try {
      const value = JSON.parse(window.CloudBoxNative?.appVersion?.() || '{}');
      return Number.isSafeInteger(value?.build) ? Number(value.build) : null;
    } catch { return null; }
  });
  const os = detectOS();

  const loadApps = async () => {
    setLoading(true);
    setLoadError(false);
    try { setPlats((await api.apps()).platforms); }
    catch { setLoadError(true); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    void loadApps();
    void window.aerieDesktopUpdater?.status().then(status => setDesktopUpdate(status)).catch(() => {});
    const stopPwa = pwa.onChange(() => setCanInstall(pwa.canInstall()));
    const stopProgress = window.aerieDesktopUpdater?.onProgress(progress => {
      setDesktopUpdateProgress(progress.totalBytes > 0 && !progress.complete
        ? { receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes }
        : null);
    });
    return () => { stopPwa(); stopProgress?.(); };
  }, []);

  const checkDesktopUpdate = async () => {
    const updater = window.aerieDesktopUpdater;
    if (!updater || desktopUpdateBusy) return;
    setDesktopUpdateBusy(true);
    try {
      await updater.check();
      setDesktopUpdate(await updater.status());
      await loadApps();
    } catch {
      toast('Update check unavailable', 'error', 'The desktop app could not start its secure update check.');
    } finally {
      setDesktopUpdateBusy(false);
      setDesktopUpdateProgress(null);
    }
  };

  const doInstall = async () => {
    const ok = await pwa.install();
    if (ok) toast('Aerie installed', 'success', 'Find it on your home screen or app launcher.');
    else if (!pwa.canInstall()) toast('Use your browser menu', 'info', 'Open the browser menu and choose "Install app" / "Add to Home Screen".');
  };

  const primary = plats.find(p => p.key === os && p.available);
  // The hero install button reads "Install now" only when the browser can install
  // the PWA; on plain HTTP it falls back to "How to install". Hint copy elsewhere
  // must reference whatever label is actually on screen.
  const installLabel = canInstall ? 'Install now' : 'How to install';

  return (
    <div className="animate-fade-in max-w-5xl">
      <PageHeader title="Get the Apps" subtitle="Install Aerie on your phone, desktop and laptop — one hub, everywhere." icon={<Icon.Download size={22} />} />

      {/* Hero install card */}
      <div className="card p-6 md:p-8 mb-6 relative overflow-hidden">
        <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-brand-500/20 blur-3xl pointer-events-none" />
        <div className="relative flex flex-col md:flex-row md:items-center gap-6">
          <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-brand-400 to-brand-600 grid place-items-center shadow-glow shrink-0">
            <Icon.Cloud size={40} className="text-white" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-bold text-white">Install Aerie as an app</h2>
            <p className="muted text-sm mt-1 max-w-xl">
              Aerie works as a Progressive Web App — it installs straight from your browser with no store, launches in its own window, and works offline for the app shell. This is the fastest way to get it on any device.
            </p>
            <div className="flex flex-wrap items-center gap-3 mt-4">
              {standalone ? (
                <Badge color="green"><Icon.Check size={13} /> Already installed</Badge>
              ) : canInstall ? (
                <button className="btn-primary" onClick={doInstall}><Icon.Download size={18} /> Install now</button>
              ) : (
                <button className="btn-secondary" onClick={doInstall}><Icon.Download size={18} /> How to install</button>
              )}
              <span className="text-xs text-slate-500">Works on Android, Windows, macOS, Linux &amp; iOS (Safari → Share → Add to Home Screen).</span>
            </div>
          </div>
        </div>
      </div>

      {/* Native downloads */}
      <h3 className="section-title mb-3">Native apps</h3>
      {loading ? (
        <div className="grid place-items-center py-12 text-brand-400"><Spinner size={28} /></div>
      ) : loadError ? (
        <div className="card p-6 text-center" role="alert">
          <p className="font-semibold text-white">Couldn’t load published apps</p>
          <p className="text-sm muted mt-1">Your current Aerie session is unaffected.</p>
          <button className="btn-secondary mt-4" onClick={() => void loadApps()}><Icon.Refresh size={16} /> Retry</button>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {plats.map(p => {
            const currentDesktop = Boolean(desktopUpdate && p.key === os && (os === 'windows' || os === 'linux'));
            const signedDesktopRelease = p.verified && p.signatureVerified
              && (p.key === 'windows' || p.key === 'linux' || p.key === 'linux-deb')
              && p.signatureAlgorithm === 'Ed25519' && !!p.signatureKeyId && !!p.signature;
            const signedAndroidRelease = p.verified && p.key === 'android' && !!p.certificateSha256;
            const updateAvailable = (signedAndroidRelease && nativeBuild != null && p.build != null && p.build > nativeBuild)
              || (currentDesktop && signedDesktopRelease && p.build != null && p.build > desktopUpdate!.currentBuild);
            const currentNative = p.key === 'android' && nativeBuild != null && p.build != null && p.build === nativeBuild;
            const currentDesktopRelease = currentDesktop && p.build != null && p.build === desktopUpdate!.currentBuild;
            return (
              <div key={p.key} className={cx('card p-5 card-hover', p.key === os && 'ring-1 ring-brand-500/40')}>
              <div className="flex items-center gap-3 mb-3">
                <div className="w-11 h-11 rounded-xl bg-white/[0.05] grid place-items-center text-slate-300">{ICON[p.key] || <Icon.Download size={24} />}</div>
                <div>
                  <p className="font-semibold text-white flex items-center gap-2 flex-wrap">
                    {p.label} {p.key === os && <Badge color="brand">Your device</Badge>}
                    {updateAvailable && <Badge color="amber">Update available</Badge>}
                    {currentNative && <Badge color="green">Up to date</Badge>}
                    {currentDesktopRelease && <Badge color="green">Up to date</Badge>}
                  </p>
                  <p className="text-xs muted">{p.kind}</p>
                </div>
              </div>
              {p.available ? (
                <>
                  {currentDesktop ? (
                    <>
                      <button type="button" className="btn-primary w-full justify-center" disabled={desktopUpdateBusy}
                        onClick={() => void checkDesktopUpdate()}>
                        {desktopUpdateBusy ? <Spinner size={17} /> : <Icon.Refresh size={17} />}
                        {desktopUpdateProgress
                          ? `Downloading ${Math.round((desktopUpdateProgress.receivedBytes / desktopUpdateProgress.totalBytes) * 100)}%`
                          : updateAvailable ? 'Update securely' : desktopUpdateBusy ? 'Checking…' : 'Check for updates'}
                      </button>
                      <a href={p.url!} download className="mt-2 block text-center text-[11px] text-slate-500 hover:text-slate-300">
                        Manual download
                      </a>
                    </>
                  ) : (
                    <a href={p.url!} download className="btn-primary w-full justify-center">
                      <Icon.Download size={17} /> {updateAvailable ? 'Download update' : 'Download'}
                    </a>
                  )}
                  <p className="text-[11px] text-slate-500 mt-2 text-center">
                    {p.filename} · {formatBytes(p.sizeBytes)}{p.version ? ` · v${p.version}` : ''}
                  </p>
                  {p.verified && (
                    <div className="flex justify-center mt-2">
                      <Badge color="green"><Icon.Check size={12} />
                        {signedDesktopRelease ? 'Signed desktop release' : signedAndroidRelease ? 'Update-signed APK' : 'Checksum verified'}
                      </Badge>
                    </div>
                  )}
                  {p.notes && <p className="text-[11px] text-slate-400 mt-2">{p.notes}</p>}
                  {p.sha256 && (
                    <button
                      type="button"
                      className="block w-full text-[10px] font-mono text-slate-600 hover:text-slate-400 mt-2 truncate"
                      title={`SHA-256: ${p.sha256} — click to copy`}
                      onClick={() => navigator.clipboard.writeText(p.sha256!).then(
                        () => toast('Checksum copied', 'success'),
                        () => toast('Couldn’t copy checksum', 'error'),
                      )}
                    >SHA-256 {p.sha256}</button>
                  )}
                  {isWebViewApk(p) && (
                    <p className="text-[11px] text-slate-500 mt-2 flex items-start gap-1.5">
                      <Icon.Info size={13} className="shrink-0 mt-0.5" />
                      <span>Lightweight Android client — a native WebView wrapper around Aerie. Installs like any app; prefers the PWA? Use “{installLabel}” above instead.</span>
                    </p>
                  )}
                  {p.key === 'android' && <QrCode url={absUrl(p.url!)} />}
                </>
              ) : (
                <div className="text-center py-2">
                  <Badge color="slate">Building…</Badge>
                  <p className="text-[11px] text-slate-500 mt-2">Not published yet — use the PWA above for now.</p>
                </div>
              )}
              </div>
            );
          })}
        </div>
      )}

      {/* Per-platform install hints */}
      <div className="grid md:grid-cols-2 gap-4 mt-6">
        <div className="card p-5">
          <h4 className="font-semibold text-white mb-2 flex items-center gap-2"><Icon.Phone size={18} /> Phone (Android / iPhone)</h4>
          <ul className="text-sm muted space-y-1.5 list-disc pl-5">
            <li><b className="text-slate-300">Android:</b> download the APK above, or tap the browser menu → “Install app”.</li>
            <li><b className="text-slate-300">iPhone:</b> open in Safari → Share → “Add to Home Screen”.</li>
            <li>Enable phone photo/video backup in Settings once installed.</li>
          </ul>
        </div>
        <div className="card p-5">
          <h4 className="font-semibold text-white mb-2 flex items-center gap-2"><Icon.Desktop size={18} /> Desktop (Windows / Linux)</h4>
          <ul className="text-sm muted space-y-1.5 list-disc pl-5">
            <li><b className="text-slate-300">Windows:</b> run the installer (.exe). After this 1.8 release, signed updates install from inside Aerie.</li>
            <li><b className="text-slate-300">Linux:</b> run the .AppImage or install the .deb. From 1.8 onward, Aerie can move either install onto its signed managed-AppImage update path.</li>
            <li>Or click “{installLabel}” above to use the browser app — no download needed.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
