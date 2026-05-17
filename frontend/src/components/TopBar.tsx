import { Icon } from "./Icon";
import type { JSX } from "preact";

// Sticky top bar with the brand mark + optional trailing slot (toggle / avatar).
export function TopBar(props: { brand?: string; right?: JSX.Element | JSX.Element[]; fixed?: boolean }) {
  const brand = props.brand ?? "Neon Lounge";
  const positioning = props.fixed
    ? "fixed top-0 left-0 right-0 z-50"
    : "sticky top-0 z-50";
  return (
    <header
      class={`${positioning} flex justify-between items-center px-gutter py-sm w-full bg-surface/40 backdrop-blur-lg border-b border-white/10 shadow-[0_4px_30px_rgba(0,0,0,0.1)]`}
    >
      <div class="flex items-center gap-sm">
        <Icon
          name="mic_external_on"
          fill
          class="text-primary text-2xl"
        />
        <div class="font-headline-md text-headline-md font-bold tracking-tighter text-primary drop-shadow-[0_0_8px_rgba(236,177,255,0.4)]">
          {brand}
        </div>
      </div>
      {props.right ? (
        <div class="flex items-center gap-md">{props.right}</div>
      ) : null}
    </header>
  );
}
