import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useCallback } from 'react';
import { useWohnIndex } from './hooks/useWohnIndex';
import { useTheme } from './hooks/useTheme';
import { usePanelOpen } from './hooks/usePanelOpen';
import { MapView } from './map/MapView';
import { ControlPanel } from './ui/ControlPanel';
import { ComparePanel } from './ui/ComparePanel';
import { DebugPanel } from './ui/DebugPanel';
import { TopBar } from './ui/TopBar';
import { HomePage } from './ui/HomePage';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';

function MapApp() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const routeSlug = slug ?? null;
  const { theme, toggleTheme, mapStyleUrl } = useTheme();
  const { panelOpen, togglePanel } = usePanelOpen();

  const onCityReady = useCallback(
    (nextSlug: string) => {
      if (nextSlug === routeSlug) return;
      navigate(`/city/${encodeURIComponent(nextSlug)}`, { replace: false });
    },
    [navigate, routeSlug],
  );

  const state = useWohnIndex({ routeSlug, onCityReady });

  if (!routeSlug) return <Navigate to="/" replace />;

  return (
    <>
      <TopBar
        cityName={state.cityName}
        theme={theme}
        onToggleTheme={toggleTheme}
        brandSlot={
          <Link to="/" className="topbar-product topbar-product-link">
            Wohnindex
          </Link>
        }
      />
      <MapView state={state} mapStyleUrl={mapStyleUrl} />
      {panelOpen ? (
        <ControlPanel state={state} onClose={togglePanel} />
      ) : (
        <button
          type="button"
          className="panel-reopen"
          onClick={togglePanel}
          title="Seitenleiste einblenden"
          aria-controls="panel"
          aria-expanded="false"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
            <path
              fill="currentColor"
              d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v12h4V6H4zm6 0v12h10V6H10z"
            />
          </svg>
          <span>Filter</span>
        </button>
      )}
      <ComparePanel state={state} />
      <DebugPanel state={state} />
      {(state.loading || state.loadError) && (
        <div id="loading" className="loading">
          {state.loadError || 'Lade Daten …'}
        </div>
      )}
      {!state.loading && !state.loadError && state.painting && (
        <div id="paint-loading" className="loading paint-loading" role="status">
          <span className="paint-spinner" aria-hidden />
          Karte wird aktualisiert …
        </div>
      )}
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/city/:slug" element={<MapApp />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
