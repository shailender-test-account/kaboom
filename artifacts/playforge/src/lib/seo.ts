export type PublicJourneySeo = {
  journeyName: string;
  description?: string | null;
  pageTitle?: string | null;
  imageUrl?: string | null;
  canonicalPath?: string | null;
  noIndex?: boolean;
};

const META_ID = "playforge-seo-jsonld";

function upsertMeta(attribute: "name" | "property", key: string, content: string) {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.content = content;
}

function upsertLink(rel: string, href: string) {
  let element = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!element) {
    element = document.createElement("link");
    element.rel = rel;
    document.head.appendChild(element);
  }
  element.href = href;
}

function removeMeta(attribute: "name" | "property", key: string) {
  document.head.querySelector(`meta[${attribute}="${key}"]`)?.remove();
}

function compact(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

/** Sets document metadata from the browser's real current URL; no deployment URL is assumed. */
export function setPublicJourneySeo(seo: PublicJourneySeo): void {
  const url = new URL(seo.canonicalPath || window.location.pathname, window.location.origin);
  const canonical = url.toString();
  const titleParts = [seo.pageTitle, seo.journeyName].filter(Boolean);
  const title = compact(titleParts.join(" | ") || "PlayForge Journey", 60);
  const description = compact(seo.description || `Explore ${seo.journeyName} on PlayForge.`, 160);
  const robots = seo.noIndex ? "noindex, nofollow" : "index, follow";
  const image = seo.imageUrl ? new URL(seo.imageUrl, url.origin).toString() : undefined;

  document.title = title;
  upsertMeta("name", "description", description);
  upsertMeta("name", "robots", robots);
  upsertLink("canonical", canonical);
  upsertMeta("property", "og:type", "website");
  upsertMeta("property", "og:title", title);
  upsertMeta("property", "og:description", description);
  upsertMeta("property", "og:url", canonical);
  upsertMeta("name", "twitter:card", image ? "summary_large_image" : "summary");
  upsertMeta("name", "twitter:title", title);
  upsertMeta("name", "twitter:description", description);
  if (image) {
    upsertMeta("property", "og:image", image);
    upsertMeta("property", "og:image:alt", `${seo.journeyName} preview`);
    upsertMeta("name", "twitter:image", image);
  } else {
    removeMeta("property", "og:image");
    removeMeta("property", "og:image:alt");
    removeMeta("name", "twitter:image");
  }

  let jsonLd = document.getElementById(META_ID) as HTMLScriptElement | null;
  if (!jsonLd) {
    jsonLd = document.createElement("script");
    jsonLd.id = META_ID;
    jsonLd.type = "application/ld+json";
    document.head.appendChild(jsonLd);
  }
  jsonLd.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    description,
    url: canonical,
    ...(image ? { primaryImageOfPage: image } : {}),
  });
}