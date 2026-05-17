import { useEffect } from "preact/hooks";

const SITE_URL = "https://dj.aiandsons.io";
const DEFAULT_DESCRIPTION =
  "DJClaude is a real-time karaoke request app for bars, DJs, and private events. Guests scan a QR code, request songs, and hosts manage the queue live.";

type SEOProps = {
  title: string;
  description?: string;
  canonicalPath?: string;
  noindex?: boolean;
};

function upsertMeta(selector: string, attrs: Record<string, string>) {
  let el = document.head.querySelector<HTMLMetaElement>(selector);
  if (!el) {
    el = document.createElement("meta");
    document.head.appendChild(el);
  }

  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
}

function upsertCanonical(href: string) {
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!el) {
    el = document.createElement("link");
    el.rel = "canonical";
    document.head.appendChild(el);
  }
  el.href = href;
}

export function SEO({
  title,
  description = DEFAULT_DESCRIPTION,
  canonicalPath = "/",
  noindex = false,
}: SEOProps) {
  useEffect(() => {
    const fullTitle = title.includes("DJClaude") ? title : `${title} | DJClaude`;
    const canonical = `${SITE_URL}${canonicalPath}`;
    const robots = noindex ? "noindex, nofollow" : "index, follow";

    document.title = fullTitle;
    upsertMeta('meta[name="description"]', { name: "description", content: description });
    upsertMeta('meta[name="robots"]', { name: "robots", content: robots });
    upsertMeta('meta[property="og:title"]', { property: "og:title", content: fullTitle });
    upsertMeta('meta[property="og:description"]', {
      property: "og:description",
      content: description,
    });
    upsertMeta('meta[property="og:url"]', { property: "og:url", content: canonical });
    upsertMeta('meta[name="twitter:title"]', { name: "twitter:title", content: fullTitle });
    upsertMeta('meta[name="twitter:description"]', {
      name: "twitter:description",
      content: description,
    });
    upsertCanonical(canonical);
  }, [canonicalPath, description, noindex, title]);

  return null;
}
