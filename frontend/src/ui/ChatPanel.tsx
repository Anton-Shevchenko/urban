import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { streamHexChat, type ChatTurn } from '../api/client';
import { useChat } from '../wohnindex';

export function ChatPanel() {
  const { chatHex, chatOpen, setChatOpen } = useChat();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setStreaming(false);
    setInput('');
  }, [chatHex?.h3, chatHex?.citySlug]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  if (!chatOpen) {
    return (
      <button
        type="button"
        className="chat-reopen"
        onClick={() => setChatOpen(true)}
        title="Hex-Chat einblenden"
        aria-controls="chat-panel"
        aria-expanded="false"
      >
        Chat
      </button>
    );
  }

  const score =
    chatHex?.livingScore != null ? Math.round(chatHex.livingScore) : '—';
  const h3Short = chatHex ? String(chatHex.h3).slice(-6) : '';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!chatHex || streaming) return;
    const message = input.trim();
    if (!message) return;
    setInput('');
    setError(null);
    const history = messages;
    setMessages((prev) => [
      ...prev,
      { role: 'user', content: message },
      { role: 'assistant', content: '' },
    ]);
    setStreaming(true);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamHexChat(
        {
          city_slug: chatHex.citySlug,
          h3: chatHex.h3,
          message,
          history,
        },
        (token) => {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === 'assistant') {
              next[next.length - 1] = { ...last, content: last.content + token };
            }
            return next;
          });
        },
        ac.signal,
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
    }
  }

  return (
    <aside id="chat-panel" aria-label="Hexagon-Chat">
      <header className="chat-head">
        <div>
          <h2>Hex-Chat</h2>
          {chatHex ? (
            <p className="chat-hex-meta">
              {chatHex.cityName} · #{h3Short} · Infrastruktur {score}
            </p>
          ) : (
            <p className="chat-hex-meta">Klicke ein Hexagon</p>
          )}
        </div>
        <button
          type="button"
          className="chat-close"
          onClick={() => setChatOpen(false)}
          aria-label="Chat ausblenden"
        >
          ×
        </button>
      </header>
      <p className="chat-hint">Klick = dieses Hexagon fragen · Shift+Klick = vergleichen · Antworten auf Englisch</p>
      <div className="chat-list" ref={listRef}>
        {!chatHex && (
          <p className="chat-empty">Klicke ein Hexagon auf der Karte, um zu fragen.</p>
        )}
        {chatHex && messages.length === 0 && (
          <p className="chat-empty">
            Ask e.g. “How far is the nearest supermarket?” or “What is missing for daily life?”
          </p>
        )}
        {messages.map((m, i) => (
          <div key={`${m.role}-${i}`} className={`chat-bubble is-${m.role}`}>
            <span className="chat-role">{m.role === 'user' ? 'Du' : 'Assistent'}</span>
            <p>{m.content || (streaming && i === messages.length - 1 ? '…' : '')}</p>
          </div>
        ))}
      </div>
      {error ? <p className="chat-error">{error}</p> : null}
      <form className="chat-form" onSubmit={onSubmit}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={chatHex ? 'Frage zu diesem Hexagon …' : 'Zuerst ein Hexagon wählen'}
          disabled={!chatHex || streaming}
          aria-label="Nachricht"
        />
        <button type="submit" disabled={!chatHex || streaming || !input.trim()}>
          {streaming ? '…' : 'Senden'}
        </button>
      </form>
    </aside>
  );
}
