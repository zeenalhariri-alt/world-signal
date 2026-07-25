export type RssSourceConfig = {
  id: string;
  name: string;
  legalName?: string;
  domain: string;
  feedUrl: string;
  languageCode?: string;
  countryCode?: string;
  category?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxItems?: number;
};

export type NormalizedRssItem = {
  externalId: string;
  canonicalUrl: string;
  title: string;
  summary?: string;
  authorText?: string;
  publishedAt?: string;
  languageCode?: string;
  categories: string[];
  rawPayload: Record<string, unknown>;
};

export type RssFetchResult = {
  source: RssSourceConfig;
  feedTitle?: string;
  fetched: number;
  returned: number;
  items: NormalizedRssItem[];
  durationMs: number;
};