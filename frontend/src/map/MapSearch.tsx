import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { fetchPlaceSuggestions, isAbortError, type PlaceSuggestion } from '../api/client';

type Props = {
  busy: boolean;
  status: string | null;
  error: boolean;
  onSelect: (query: string) => void;
};

export function MapSearch({ busy, status, error, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chosenRef = useRef(false);
  const listId = useId();

  useEffect(() => {
    if (chosenRef.current) {
      chosenRef.current = false;
      return undefined;
    }
    const q = query.trim();
    if (q.length < 2) {
      setItems([]);
      setOpen(false);
      setSuggestError(null);
      return undefined;
    }
    const handle = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      void fetchPlaceSuggestions(q, { signal: controller.signal })
        .then((rows) => {
          setItems(rows);
          setActive(0);
          setOpen(true);
          setSuggestError(null);
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) return;
          setItems([]);
          setSuggestError('Vorschläge nicht verfügbar');
          setOpen(true);
        });
    }, 300);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const choose = (item: PlaceSuggestion) => {
    chosenRef.current = true;
    setQuery(item.label);
    setOpen(false);
    setItems([]);
    onSelect(item.label);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(items.length > 0);
      setActive((index) => Math.min(index + 1, Math.max(items.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (open && items[active]) {
        choose(items[active]);
        return;
      }
      if (query.trim().length >= 2) {
        setOpen(false);
        onSelect(query.trim());
      }
    }
  };

  const activeId = open && items[active] ? `${listId}-${active}` : undefined;

  return (
    <div className="map-search" ref={boxRef}>
      <input
        id="cycleway-search"
        className="map-search-input"
        role="combobox"
        type="search"
        value={query}
        placeholder="Stadt suchen, z. B. Freising"
        autoComplete="off"
        aria-label="Deutsche Stadt suchen"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => {
          if (items.length > 0) setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul className="map-search-list" id={listId} role="listbox" aria-label="Ortsvorschläge">
          {suggestError ? <li className="map-search-empty">{suggestError}</li> : null}
          {!suggestError && items.length === 0 ? (
            <li className="map-search-empty">Keine Orte in Deutschland</li>
          ) : null}
          {items.map((item, index) => (
            <li
              key={`${item.name}-${item.state}-${item.type}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'is-active' : undefined}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(item);
              }}
            >
              <span className="map-search-name">{item.name}</span>
              {item.state ? <span className="map-search-state">{item.state}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {status ? (
        <p
          id="cycleway-status"
          className={`map-search-status${error ? ' is-error' : ''}${busy ? ' is-busy' : ''}`}
          role="status"
        >
          {status}
        </p>
      ) : null}
    </div>
  );
}
