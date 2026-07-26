import { useCallback, useState } from 'react';
import { STORAGE } from '../scoring/constants';

function readPanelOpen(): boolean {
  try {
    const v = localStorage.getItem(STORAGE.panelOpen);
    if (v === '0' || v === 'false') return false;
    if (v === '1' || v === 'true') return true;
  } catch {
    /* */
  }
  return true;
}

export function usePanelOpen() {
  const [panelOpen, setPanelOpenState] = useState(readPanelOpen);

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenState(open);
    try {
      localStorage.setItem(STORAGE.panelOpen, open ? '1' : '0');
    } catch {
      /* */
    }
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpenState((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE.panelOpen, next ? '1' : '0');
      } catch {
        /* */
      }
      return next;
    });
  }, []);

  return { panelOpen, setPanelOpen, togglePanel };
}
