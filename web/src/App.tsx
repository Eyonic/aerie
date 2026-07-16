import React, { lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './lib/store';
import { Layout } from './components/Layout';
import { PageLoader } from './components/ui';
import Login from './pages/Login'; // eager: it's the entry point / first paint
import SharePage from './pages/SharePage'; // eager: public route, outside Suspense

// Every other page is code-split into its own chunk so the initial mobile load
// only downloads the shell + the page you land on. Huge win on phones/slow links.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Files = lazy(() => import('./pages/Files'));
const Photos = lazy(() => import('./pages/Photos'));
const Videos = lazy(() => import('./pages/Videos'));
const Movies = lazy(() => import('./pages/Movies'));
const TVShows = lazy(() => import('./pages/TVShows'));
const Music = lazy(() => import('./pages/Music'));
const Audiobooks = lazy(() => import('./pages/Audiobooks'));
const Podcasts = lazy(() => import('./pages/Podcasts'));
const History = lazy(() => import('./pages/History'));
const Documents = lazy(() => import('./pages/Documents'));
const Spreadsheets = lazy(() => import('./pages/Spreadsheets'));
const ImageEditor = lazy(() => import('./pages/ImageEditor'));
const AIImageStudio = lazy(() => import('./pages/AIImageStudio'));
const MusicStudio = lazy(() => import('./pages/MusicStudio'));
const Assistant = lazy(() => import('./pages/Assistant'));
const Automations = lazy(() => import('./pages/Automations'));
const Backups = lazy(() => import('./pages/Backups'));
const FolderSync = lazy(() => import('./pages/FolderSync'));
const Monitoring = lazy(() => import('./pages/Monitoring'));
const Admin = lazy(() => import('./pages/Admin'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Settings = lazy(() => import('./pages/Settings'));
const GetApps = lazy(() => import('./pages/GetApps'));
const Requests = lazy(() => import('./pages/Requests'));
const Downloads = lazy(() => import('./pages/Downloads'));
const Jobs = lazy(() => import('./pages/Jobs'));

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="h-full grid place-items-center"><PageLoader /></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/s/:id" element={<SharePage />} />
        <Route element={<Protected><Layout /></Protected>}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/files" element={<Files />} />
          <Route path="/photos" element={<Photos />} />
          <Route path="/videos" element={<Videos />} />
          <Route path="/movies" element={<Movies />} />
          <Route path="/tv" element={<TVShows />} />
          <Route path="/music" element={<Music />} />
          <Route path="/audiobooks" element={<Audiobooks />} />
          <Route path="/podcasts" element={<Podcasts />} />
          <Route path="/history" element={<History />} />
          <Route path="/documents" element={<Documents />} />
          <Route path="/documents/:id" element={<Documents />} />
          <Route path="/spreadsheets" element={<Spreadsheets />} />
          <Route path="/spreadsheets/:id" element={<Spreadsheets />} />
          <Route path="/image-editor" element={<ImageEditor />} />
          <Route path="/ai-images" element={<AIImageStudio />} />
          <Route path="/music-studio" element={<MusicStudio />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/automations" element={<Automations />} />
          <Route path="/backups" element={<Backups />} />
          <Route path="/sync" element={<FolderSync />} />
          <Route path="/monitoring" element={<Monitoring />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/get-apps" element={<GetApps />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/downloads" element={<Downloads />} />
          <Route path="/jobs" element={<Jobs />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
