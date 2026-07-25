import { parseRssOrAtom } from "./rss-parser";
import type {
  RssFetchResult,
  RssSourceConfig,
} from "./rss-types";

export class RssProvider {
  constructor(
    public readonly source: RssSourceConfig,
  ) {}

  async fetchLatest(): Promise<RssFetchResult> {
    const startedAt = Date.now();
    const timeoutMs = this.source.timeoutMs ?? 15000;

    const response = await fetch(
      this.source.feedUrl,
      {
        headers: {
          "User-Agent":
            "WorldSignal/1.0 (+https://world-signal.vercel.app)",
          Accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );

    if (!response.ok) {
      throw new Error(
        `${this.source.name} feed request failed with HTTP ${response.status}.`,
      );
    }

    const xml = await response.text();

    if (!xml.trim()) {
      throw new Error(
        `${this.source.name} returned an empty feed.`,
      );
    }

    return parseRssOrAtom(
      xml,
      this.source,
      startedAt,
    );
  }
}