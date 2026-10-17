import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useCallback } from 'react';
import { CompareSessionProvider, WohnIndexProvider, useCityData, useMapViewState, usePaint } from './wohnindex';
import { useTheme, type ThemeMode } from './hooks/useTheme';
import { usePanelOpen } from './hooks/usePanelOpen';
import { displayCityChrome } from './map/cyclewayChrome';
import { MapView } from './map/MapView';
import { useCyclewaySearch } from './map/useCyclewaySearch';
import { CFG } from './scoring/constants';
import { ControlPanel } from './ui/ControlPanel';
import { ComparePanel } from './ui/ComparePanel';
import { ChatPanel } from './ui/ChatPanel';
import { DebugPanel } from './ui/DebugPanel';
import { TopBar } from './ui/TopBar';
import { HomePage } from './ui/HomePage';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/index.css';

function MapAppShell({
  theme,
  toggleTheme,
  mapStyleUrl,
  panelOpen,
  togglePanel,
}: {
  theme: ThemeMode;
  toggleTheme: () => void;
  mapStyleUrl: string;
  panelOpen: boolean;
  togglePanel: () => void;
}) {
  const { cityName, citySlug, meta, features, loading, loadError } = useCityData();
  const { painting } = usePaint();
  const { mapView, paintMapView, setMapView } = useMapViewState();
  const cyclewaySearch = useCyclewaySearch(setMapView);
  const chrome = displayCityChrome({
    mapView,
    wohnindexName: cityName,
    wohnindexSlug: citySlug,
    cyclewayName: cyclewaySearch.name,
    cyclewaySlug: cyclewaySearch.slug,
    meta,
    featureCount: features.length,
  });
  const cyclewaysOn = mapView === 'cycleways' || paintMapView === 'cycleways';
  const activeStyleUrl = cyclewaysOn ? CFG.styleUrl : mapStyleUrl;

  return (
    <>
      <TopBar
        cityName={chrome.cityName}
        theme={theme}
        onToggleTheme={toggleTheme}
        brandSlot={
          <Link to="/" className="topbar-product topbar-product-link">
            Wohnindex
          </Link>
        }
      />
      <MapView mapStyleUrl={activeStyleUrl} cyclewaySearch={cyclewaySearch} />
      {panelOpen ? (
        <ControlPanel
          onClose={togglePanel}
          cityLabel={chrome.cityName}
          hexSummary={chrome.hexSummary}
          cityType={chrome.cityType}
        />
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
      <ComparePanel />
      <ChatPanel />
      <DebugPanel />
      {(loading || loadError) && (
        <div id="loading" className="loading">
          {loadError || 'Lade Daten …'}
        </div>
      )}
      {!loading && !loadError && painting && (
        <div id="paint-loading" className="loading paint-loading" role="status">
          <span className="paint-spinner" aria-hidden />
          Karte wird aktualisiert …
        </div>
      )}
    </>
  );
}

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

  if (!routeSlug) return <Navigate to="/" replace />;

  return (
    <WohnIndexProvider routeSlug={routeSlug} onCityReady={onCityReady}>
      <MapAppShell
        theme={theme}
        toggleTheme={toggleTheme}
        mapStyleUrl={mapStyleUrl}
        panelOpen={panelOpen}
        togglePanel={togglePanel}
      />
    </WohnIndexProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <CompareSessionProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/city/:slug" element={<MapApp />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </CompareSessionProvider>
    </BrowserRouter>
  );
}
