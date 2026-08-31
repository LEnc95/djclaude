import { DEVELOPER_DONATE_URL, DJ_TIP_URL } from "../config";
import { Icon } from "./Icon";

type DonationLinksProps = {
  compact?: boolean;
};

const links = [
  {
    href: DJ_TIP_URL,
    label: "Tip the DJ",
    icon: "volunteer_activism",
    tone: "secondary",
  },
  {
    href: DEVELOPER_DONATE_URL,
    label: "Donate to developer",
    icon: "code",
    tone: "tertiary",
  },
].filter((link) => link.href);

export function DonationLinks({ compact = false }: DonationLinksProps) {
  if (!links.length) return null;

  return (
    <section
      class={`glass-panel rounded-xl ${compact ? "p-sm" : "p-md"} flex flex-col gap-sm text-center`}
      aria-label="Support links"
    >
      {!compact && (
        <div>
          <h3 class="font-headline-md text-headline-md text-on-surface">
            Support the night
          </h3>
          <p class="font-body-md text-sm text-on-surface-variant mt-1">
            Tips and donations open in a new tab.
          </p>
        </div>
      )}
      <div class={`grid gap-sm ${links.length === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
        {links.map((link) => (
          <a
            key={link.label}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            class={`h-11 rounded-lg flex items-center justify-center gap-2 font-label-caps text-label-caps font-bold border-2 transition-colors ${
              link.tone === "secondary"
                ? "border-secondary text-secondary hover:bg-secondary/10"
                : "border-tertiary text-tertiary hover:bg-tertiary/10"
            }`}
          >
            <Icon name={link.icon} class="text-[18px]" />
            {link.label}
          </a>
        ))}
      </div>
    </section>
  );
}
