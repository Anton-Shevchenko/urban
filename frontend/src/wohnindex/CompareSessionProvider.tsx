import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Feature } from 'geojson';
import { STORAGE } from '../scoring/constants';
import { CompareContext, type CompareSlice } from './contexts';
import {
  addCompareList,
  compareListHas,
  migrateCompareItems,
  type CompareCityRef,
} from './compareSnapshot';
import { loadJson } from './helpers';
import type { CompareFocus, CompareItem } from './types';

export function CompareSessionProvider({ children }: { children: ReactNode }) {
  const [comparison, setComparison] = useState<CompareItem[]>(() =>
    migrateCompareItems(loadJson(STORAGE.compare, [])),
  );
  const [pendingFocus, setPendingFocus] = useState<CompareFocus | null>(null);
  const [pendingChatPrompt, setPendingChatPrompt] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE.compare, JSON.stringify(comparison));
    } catch {
      /* */
    }
  }, [comparison]);

  const addCompare = useCallback((feature: Feature, city: CompareCityRef) => {
    setComparison((prev) => addCompareList(prev, feature, city));
  }, []);

  const isCompared = useCallback(
    (citySlug: string, h3: string, cityName?: string) =>
      compareListHas(comparison, citySlug, h3, cityName),
    [comparison],
  );

  const requestFocus = useCallback((item: CompareItem) => {
    if (!item.citySlug) return;
    setPendingFocus({
      citySlug: item.citySlug,
      h3: item.h3,
      lng: item.lng ?? null,
      lat: item.lat ?? null,
    });
  }, []);

  const clearFocus = useCallback(() => setPendingFocus(null), []);
  const requestChatPrompt = useCallback((message: string) => {
    setPendingChatPrompt(message.trim() || null);
  }, []);
  const clearChatPrompt = useCallback(() => setPendingChatPrompt(null), []);

  const value = useMemo<CompareSlice>(
    () => ({
      comparison,
      setComparison,
      addCompare,
      isCompared,
      pendingFocus,
      requestFocus,
      clearFocus,
      pendingChatPrompt,
      requestChatPrompt,
      clearChatPrompt,
    }),
    [
      comparison,
      addCompare,
      isCompared,
      pendingFocus,
      requestFocus,
      clearFocus,
      pendingChatPrompt,
      requestChatPrompt,
      clearChatPrompt,
    ],
  );

  return <CompareContext.Provider value={value}>{children}</CompareContext.Provider>;
}
