import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { Song } from "../types";
import { mediaURL } from "../config";

interface Props {
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
  className?: string;
}

// SongAutocomplete — search-as-you-type against the processed library.
// Shows up to ~8 matches with thumbnail + title + artist. Clicking a
// suggestion replaces the input text with "{Artist} - {Title}" so the
// backend's createRequest resolver canonical-hash matches it instantly.
// Empty result set shows a "no match — submit anyway" hint so users
// know they can still request a YouTube URL or a free-text title.
export function SongAutocomplete(props: Props) {
  const [suggestions, setSuggestions] = useState<Song[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<number | undefined>(undefined);

  // Debounced library search whenever the input changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = props.value.trim();

    // Don't search for empty input or YouTube URLs (passing a URL through
    // search would be useless; the backend resolves URLs directly).
    if (q.length < 2 || /^https?:\/\//i.test(q)) {
      setSuggestions([]);
      setSearched(false);
      return;
    }

    debounceRef.current = window.setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api.searchLibrary(q);
        setSuggestions(r.songs || []);
        setSearched(true);
      } catch {
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 220);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [props.value]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function pick(s: Song) {
    props.onChange(`${s.artist} - ${s.title}`);
    setOpen(false);
  }

  const showDropdown = open && (loading || suggestions.length > 0 || searched);

  return (
    <div ref={wrapRef} class="song-autocomplete">
      <input
        type="text"
        required
        class={props.className}
        placeholder={props.placeholder ?? "Type a song or paste a YouTube URL"}
        value={props.value}
        onInput={(e) => {
          props.onChange((e.target as HTMLInputElement).value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        autoComplete="off"
      />

      {showDropdown && (
        <div class="song-autocomplete__dropdown">
          {loading && (
            <div class="song-autocomplete__row song-autocomplete__row--meta">
              Searching library…
            </div>
          )}
          {!loading && suggestions.length === 0 && searched && (
            <div class="song-autocomplete__row song-autocomplete__row--meta">
              <strong>Not in library yet.</strong>
              <span> Submit anyway — we'll fetch it from YouTube and add it.</span>
            </div>
          )}
          {!loading && suggestions.map((s) => (
            <button
              type="button"
              key={s.id}
              class="song-autocomplete__row"
              onClick={() => pick(s)}
            >
              {s.primary_media?.thumb_path ? (
                <img
                  class="song-autocomplete__thumb"
                  src={mediaURL(s.primary_media.thumb_path)}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <div class="song-autocomplete__thumb song-autocomplete__thumb--blank" />
              )}
              <div class="song-autocomplete__text">
                <div class="song-autocomplete__title">{s.title}</div>
                <div class="song-autocomplete__artist">{s.artist}{s.year ? ` · ${s.year}` : ""}</div>
              </div>
              <span class="song-autocomplete__badge">In library</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
