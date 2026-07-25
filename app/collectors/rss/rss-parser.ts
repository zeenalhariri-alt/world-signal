import { XMLParser } from "fast-xml-parser";
import type {
  NormalizedRssItem,
  RssFetchResult,
  RssSourceConfig,
} from "./rss-types";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    return value as UnknownRecord;
  }

  return {};
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const cleaned = value.trim();
    return cleaned.length > 0 ? cleaned : undefined;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const record = value as UnknownRecord;

    return (
      asText(record["#text"]) ??
      asText(record["@_href"]) ??
      asText(record["@_url"])
    );
  }

  return undefined;
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value === undefined || value === null) {
    return [];
  }

  return [value];
}

function stripHtml(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const cleaned = value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function normalizeLink(value: unknown): string | undefined {
  const direct = asText(value);

  if (direct?.startsWith("http")) {
    return direct;
  }

  for (const candidate of asArray(value)) {
    const record = asRecord(candidate);

    const href = asText(record["@_href"]);
    const rel = asText(record["@_rel"]);

    if (href && (!rel || rel === "alternate")) {
      return href;
    }
  }

  return direct;
}

function parseRssItems(
  channel: UnknownRecord,
  source: RssSourceConfig,
): NormalizedRssItem[] {
  const rawItems = asArray(channel.item);

  return rawItems
    .slice(0, source.maxItems ?? 20)
    .map((rawItem): NormalizedRssItem | null => {
      const item = asRecord(rawItem);

      const title = asText(item.title);
      const canonicalUrl = normalizeLink(item.link);
      const externalId =
        asText(item.guid) ??
        canonicalUrl ??
        title;

      if (!title || !canonicalUrl || !externalId) {
        return null;
      }

      return {
        externalId,
        canonicalUrl,
        title,
        summary: stripHtml(
          asText(item.description),
        ),
        authorText:
          asText(item.author) ??
          source.name,
        publishedAt: normalizeDate(
          asText(item.pubDate),
        ),
        languageCode: source.languageCode,
        categories: asArray(item.category)
          .map(asText)
          .filter(
            (v): v is string => Boolean(v),
          ),
        rawPayload: asRecord(rawItem),
      };
    })
    .filter(
      (v): v is NormalizedRssItem =>
        v !== null,
    );
}

export function parseRssOrAtom(
  xml: string,
  source: RssSourceConfig,
  startedAt: number,
): RssFetchResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
    parseTagValue: false,
  });

  const parsed = asRecord(parser.parse(xml));
  const rss = asRecord(parsed.rss);
  const channel = asRecord(rss.channel);

  const items = parseRssItems(channel, source);

  return {
    source,
    feedTitle: asText(channel.title),
    fetched: asArray(channel.item).length,
    returned: items.length,
    items,
    durationMs: Date.now() - startedAt,
  };
}