import type { RssSourceConfig } from "./rss-types";
export const RSS_SOURCES: RssSourceConfig[] = [
  {
    id: "bbc-world",
    name: "BBC World",
    legalName: "British Broadcasting Corporation",
    domain: "bbc.co.uk",
    feedUrl:
      "http://newsrss.bbc.co.uk/rss/newsonline_uk_edition/world/rss.xml",
    languageCode: "en",
    countryCode: "GB",
    category: "world",
    enabled: true,
    timeoutMs: 15000,
    maxItems: 20,
  },
];

export function getEnabledRssSources(): RssSourceConfig[] {
  return RSS_SOURCES.filter(
    (source) => source.enabled !== false,
  );
}