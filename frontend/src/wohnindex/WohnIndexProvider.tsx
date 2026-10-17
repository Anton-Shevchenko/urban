import { useMemo, type ReactNode } from 'react';
import type { UseWohnIndexOptions } from './types';
import { useWohnIndexStore } from './store';
import {
  ChatContext,
  CityDataContext,
  DestinationsContext,
  MapViewContext,
  PaintContext,
  WeightsContext,
  type ChatSlice,
  type CityDataSlice,
  type DestinationsSlice,
  type MapViewSlice,
  type PaintSlice,
  type WeightsSlice,
} from './contexts';

export function WohnIndexProvider({
  children,
  routeSlug = null,
  onCityReady,
}: UseWohnIndexOptions & { children: ReactNode }) {
  const store = useWohnIndexStore({ routeSlug, onCityReady });

  const city = useMemo<CityDataSlice>(() => ({
    loading: store.loading,
    loadError: store.loadError,
    features: store.features,
    meta: store.meta,
    cityName: store.cityName,
    citySlug: store.citySlug,
    hasRent: store.hasRent,
    searchStatus: store.searchStatus,
    searching: store.searching,
    dataEpoch: store.dataEpoch,
    runSearch: store.runSearch,
    refreshCity: store.refreshCity,
  }), [
    store.loading,
    store.loadError,
    store.features,
    store.meta,
    store.cityName,
    store.citySlug,
    store.hasRent,
    store.searchStatus,
    store.searching,
    store.dataEpoch,
    store.runSearch,
    store.refreshCity,
  ]);

  const weights = useMemo<WeightsSlice>(() => ({
    weights: store.weights,
    setPillarWeightPercent: store.setPillarWeightPercent,
    desiredAreaM2: store.desiredAreaM2,
    setDesiredAreaM2: store.setDesiredAreaM2,
    maxMonthlyBudget: store.maxMonthlyBudget,
    setMaxMonthlyBudget: store.setMaxMonthlyBudget,
    activeProfile: store.activeProfile,
    applyPreset: store.applyPreset,
  }), [
    store.weights,
    store.setPillarWeightPercent,
    store.desiredAreaM2,
    store.setDesiredAreaM2,
    store.maxMonthlyBudget,
    store.setMaxMonthlyBudget,
    store.activeProfile,
    store.applyPreset,
  ]);

  const destinations = useMemo<DestinationsSlice>(() => ({
    destinations: store.destinations,
    pickDestinationMode: store.pickDestinationMode,
    addDestination: store.addDestination,
  }), [
    store.destinations,
    store.pickDestinationMode,
    store.addDestination,
  ]);

  const mapView = useMemo<MapViewSlice>(() => ({
    mapView: store.mapView,
    paintMapView: store.paintMapView,
    setMapView: store.setMapView,
    mapViewOptions: store.mapViewOptions,
    showHiddenGems: store.showHiddenGems,
    setShowHiddenGems: store.setShowHiddenGems,
  }), [
    store.mapView,
    store.paintMapView,
    store.setMapView,
    store.mapViewOptions,
    store.showHiddenGems,
    store.setShowHiddenGems,
  ]);

  const chat = useMemo<ChatSlice>(() => ({
    chatHex: store.chatHex,
    chatOpen: store.chatOpen,
    setChatOpen: store.setChatOpen,
    selectChatHex: store.selectChatHex,
    setChatHex: store.setChatHex,
  }), [store.chatHex, store.chatOpen, store.setChatOpen, store.selectChatHex, store.setChatHex]);

  const paint = useMemo<PaintSlice>(() => ({
    painting: store.painting,
    setPainting: store.setPainting,
    paintVersion: store.paintVersion,
    onPaintComplete: store.onPaintComplete,
    engine: store.engine,
    debugMode: store.debugMode,
    debugReport: store.debugReport,
  }), [
    store.painting,
    store.setPainting,
    store.paintVersion,
    store.onPaintComplete,
    store.engine,
    store.debugMode,
    store.debugReport,
  ]);

  return (
    <CityDataContext.Provider value={city}>
      <WeightsContext.Provider value={weights}>
        <DestinationsContext.Provider value={destinations}>
          <MapViewContext.Provider value={mapView}>
            <ChatContext.Provider value={chat}>
              <PaintContext.Provider value={paint}>
                {children}
              </PaintContext.Provider>
            </ChatContext.Provider>
          </MapViewContext.Provider>
        </DestinationsContext.Provider>
      </WeightsContext.Provider>
    </CityDataContext.Provider>
  );
}
