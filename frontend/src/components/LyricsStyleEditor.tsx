import { useState } from "preact/hooks";
import type { LyricsPresetName, LyricsStyle } from "../types";
import { LYRICS_PRESETS } from "../lyrics/presets";

interface Props {
  value: LyricsStyle;
  onChange: (v: LyricsStyle) => void;
}

const PRESET_LABEL: Record<LyricsPresetName, string> = {
  neon: "Neon",
  classic: "Classic",
  concert: "Concert",
  vaporwave: "Vaporwave",
  minimal: "Minimal",
  custom: "Custom",
};

export function LyricsStyleEditor({ value, onChange }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(value.preset === "custom");

  function selectPreset(p: LyricsPresetName) {
    onChange(LYRICS_PRESETS[p]);
    setAdvancedOpen(p === "custom");
  }

  function patch(partial: Partial<LyricsStyle>) {
    // Any manual edit means we're now in custom-land.
    onChange({ ...value, ...partial, preset: "custom" });
    setAdvancedOpen(true);
  }

  return (
    <div class="lyrics-editor">
      <div class="lyrics-editor__presets">
        {(Object.keys(LYRICS_PRESETS) as LyricsPresetName[]).map((p) => (
          <button
            type="button"
            key={p}
            class={`lyrics-editor__preset ${value.preset === p ? "is-active" : ""}`}
            onClick={() => selectPreset(p)}
          >
            {PRESET_LABEL[p]}
          </button>
        ))}
      </div>

      <button
        type="button"
        class="lyrics-editor__toggle"
        onClick={() => setAdvancedOpen((o) => !o)}
      >
        {advancedOpen ? "Hide" : "Show"} advanced
      </button>

      {advancedOpen && (
        <div class="lyrics-editor__advanced">
          <div class="lyrics-editor__row">
            <label>
              Text color
              <input type="color" value={value.textColor}
                onInput={(e) => patch({ textColor: (e.target as HTMLInputElement).value })} />
            </label>
            <label>
              Active word
              <input type="color" value={value.activeColor}
                onInput={(e) => patch({ activeColor: (e.target as HTMLInputElement).value })} />
            </label>
            <label>
              Upcoming
              <input type="color" value={value.upcomingColor}
                onInput={(e) => patch({ upcomingColor: (e.target as HTMLInputElement).value })} />
            </label>
          </div>

          <div class="lyrics-editor__row">
            <label>
              Font size
              <input type="number" min={24} max={160} value={value.fontSize}
                onInput={(e) => patch({ fontSize: Number((e.target as HTMLInputElement).value) })} />
            </label>
            <label>
              Weight
              <select value={String(value.fontWeight)}
                onChange={(e) => patch({ fontWeight: Number((e.target as HTMLSelectElement).value) })}>
                {[300, 400, 500, 600, 700, 800, 900].map((w) =>
                  <option key={w} value={w}>{w}</option>)}
              </select>
            </label>
            <label>
              Align
              <select value={value.textAlign}
                onChange={(e) => patch({ textAlign: (e.target as HTMLSelectElement).value as any })}>
                <option value="center">Center</option>
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </label>
          </div>

          <div class="lyrics-editor__row">
            <label>
              Font family
              <input type="text" value={value.fontFamily}
                onInput={(e) => patch({ fontFamily: (e.target as HTMLInputElement).value })} />
            </label>
            <label>
              Letter spacing
              <input type="number" min={0} max={20} step={0.5} value={value.letterSpacing}
                onInput={(e) => patch({ letterSpacing: Number((e.target as HTMLInputElement).value) })} />
            </label>
            <label class="lyrics-editor__check">
              <input type="checkbox" checked={value.uppercase}
                onChange={(e) => patch({ uppercase: (e.target as HTMLInputElement).checked })} />
              UPPERCASE
            </label>
          </div>

          <fieldset>
            <legend>Shadow (auto-contrasts when "auto")</legend>
            <div class="lyrics-editor__row">
              <label class="lyrics-editor__check">
                <input type="checkbox" checked={value.shadowEnabled}
                  onChange={(e) => patch({ shadowEnabled: (e.target as HTMLInputElement).checked })} />
                Shadow on
              </label>
              <label>
                Color
                <select value={value.shadowColor === "auto" ? "auto" : "custom"}
                  onChange={(e) => patch({ shadowColor: (e.target as HTMLSelectElement).value === "auto" ? "auto" : "#000000" })}>
                  <option value="auto">Auto-contrast</option>
                  <option value="custom">Custom</option>
                </select>
              </label>
              {value.shadowColor !== "auto" && (
                <label>
                  Custom
                  <input type="color" value={value.shadowColor}
                    onInput={(e) => patch({ shadowColor: (e.target as HTMLInputElement).value })} />
                </label>
              )}
              <label>
                Opacity
                <input type="range" min={0} max={1} step={0.05} value={value.shadowOpacity}
                  onInput={(e) => patch({ shadowOpacity: Number((e.target as HTMLInputElement).value) })} />
              </label>
              <label>
                Blur
                <input type="number" min={0} max={60} value={value.shadowBlur}
                  onInput={(e) => patch({ shadowBlur: Number((e.target as HTMLInputElement).value) })} />
              </label>
            </div>
          </fieldset>

          <fieldset>
            <legend>Backing panel</legend>
            <div class="lyrics-editor__row">
              <label class="lyrics-editor__check">
                <input type="checkbox" checked={value.bgPanelEnabled}
                  onChange={(e) => patch({ bgPanelEnabled: (e.target as HTMLInputElement).checked })} />
                Panel on
              </label>
              <label>
                Opacity
                <input type="range" min={0} max={1} step={0.05} value={value.bgPanelOpacity}
                  onInput={(e) => patch({ bgPanelOpacity: Number((e.target as HTMLInputElement).value) })} />
              </label>
            </div>
          </fieldset>
        </div>
      )}
    </div>
  );
}
