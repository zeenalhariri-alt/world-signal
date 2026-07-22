export interface GlobalNewsItem {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  source: string;
  language?: string;
  summary?: string;
  raw: unknown;
}

export interface GlobalNewsProvider {
  name: string;

  fetchLatest(): Promise<GlobalNewsItem[]>;
}