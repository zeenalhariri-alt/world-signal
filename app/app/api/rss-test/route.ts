import { NextRequest, NextResponse } from "next/server";
import { XMLParser } from "fast-xml-parser";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { saveSignal } from "../../../services/memory-engine";

const RSS_FEED_URL =
  "http://newsrss.bbc.co.uk/rss/newsonline_uk_edition/world/rss.xml";

const SOURCE_TYPE_CODE = "rss";
const SOURCE_DOMAIN = "bbc.co.uk";

type UnknownRecord = Record<string, unknown>;

function isAuthorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    throw new Error(
      "CRON_SECRET is missing from environment variables.",
    );
  }

  const suppliedSecret = request.headers.get("x-cron-secret");

  return suppliedSecret === cronSecret;
}

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

function asText(value: unknown): string | null {
  if (typeof value === "string") {
    const cleaned = value.trim();
    return cleaned.length > 0 ? cleaned : null;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return null;
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

function stripHtml(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRawPayload(
  raw: unknown,
): Record<string, unknown> {
  if (
    typeof raw === "object" &&
    raw !== null &&
    !Array.isArray(raw)
  ) {
    return raw as Record<string, unknown>;
  }

  return { value: raw };
}

async function getBbcRssSourceId(): Promise<string> {
  const { data: sourceType, error: sourceTypeError } =
    await supabaseAdmin
      .schema("core")
      .from("source_types")
      .select("id")
      .eq("code", SOURCE_TYPE_CODE)
      .maybeSingle();

  if (sourceTypeError) {
    throw new Error(
      `Source type lookup failed: ${sourceTypeError.message}`,
    );
  }

  let sourceTypeId = sourceType?.id;

  if (!sourceTypeId) {
    const { data: newSourceType, error: createTypeError } =
      await supabaseAdmin
        .schema("core")
        .from("source_types")
        .insert({
          code: SOURCE_TYPE_CODE,
          name: "RSS Feed",
          description: "RSS or Atom syndication feed",
        })
        .select("id")
        .single();

    if (createTypeError) {
      throw new Error(
        `Source type creation failed: ${createTypeError.message}`,
      );
    }

    if (!newSourceType?.id) {
      throw new Error(
        "Source type creation succeeded but returned no ID.",
      );
    }

    sourceTypeId = newSourceType.id;
  }

  const { data: source, error: sourceError } =
    await supabaseAdmin
      .schema("core")
      .from("sources")
      .select("id")
      .eq("domain", SOURCE_DOMAIN)
      .maybeSingle();

  if (sourceError) {
    throw new Error(
      `Source lookup failed: ${sourceError.message}`,
    );
  }

  if (source?.id) {
    return source.id;
  }

  const { data: newSource, error: createSourceError } =
    await supabaseAdmin
      .schema("core")
      .from("sources")
      .insert({
        source_type_id: sourceTypeId,
        name: "BBC World RSS",
        legal_name: "British Broadcasting Corporation",
        domain: SOURCE_DOMAIN,
      })
      .select("id")
      .single();

  if (createSourceError) {
    throw new Error(
      `Source creation failed: ${createSourceError.message}`,
    );
  }

  if (!newSource?.id) {
    throw new Error(
      "Source creation succeeded but returned no ID.",
    );
  }

  return newSource.id;
}

async function handleRequest(request: NextRequest) {
  const startedAt = Date.now();

  try {
    if (!isAuthorized(request)) {
      return NextResponse.json(
        {
          success: false,
          error: "Unauthorized",
        },
        { status: 401 },
      );
    }

    const sourceId = await getBbcRssSourceId();

    const response = await fetch(RSS_FEED_URL, {
      headers: {
        "User-Agent": "WorldSignal/1.0",
        Accept:
          "application/rss+xml, application/xml, text/xml",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(
        `RSS request failed with status ${response.status}.`,
      );
    }

    const xml = await response.text();

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      trimValues: true,
      parseTagValue: false,
    });

    const parsed = asRecord(parser.parse(xml));
    const rss = asRecord(parsed.rss);
    const channel = asRecord(rss.channel);
    const rawItems = asArray(channel.item);

    let created = 0;
    let alreadyExists = 0;

    const failures: Array<{
      url: string;
      error: string;
    }> = [];

    for (const rawItem of rawItems.slice(0, 20)) {
      const item = asRecord(rawItem);

      const title = asText(item.title);
      const url = asText(item.link);
      const guid = asText(item.guid);
      const summary = stripHtml(
        asText(item.description),
      );
      const publishedAt = asText(item.pubDate);

      if (!title || !url) {
        failures.push({
          url: url ?? "missing-url",
          error: "RSS item is missing title or URL.",
        });

        continue;
      }

      try {
        const result = await saveSignal({
          sourceId,
          externalId: guid ?? url,
          canonicalUrl: url,
          documentType: "article",
          title,
          authorText: "BBC",
          languageCode: "en",
          contentType: "application/rss+xml",
          publishedAt: publishedAt ?? undefined,
          rawText: summary ?? title,
          rawPayload: normalizeRawPayload(rawItem),
          metadata: {
            provider: "bbc-rss",
            feedUrl: RSS_FEED_URL,
            feedTitle: asText(channel.title),
            categories: asArray(item.category)
              .map(asText)
              .filter(
                (value): value is string =>
                  value !== null,
              ),
          },
        });

        if (result.status === "created") {
          created += 1;
        } else {
          alreadyExists += 1;
        }
      } catch (error) {
        failures.push({
          url,
          error:
            error instanceof Error
              ? error.message
              : "Unknown save error",
        });
      }
    }

    return NextResponse.json({
      success: true,
      provider: "bbc-rss",
      feedUrl: RSS_FEED_URL,
      fetched: rawItems.length,
      processed: Math.min(rawItems.length, 20),
      created,
      alreadyExists,
      failed: failures.length,
      failures,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown RSS collector error",
        durationMs: Date.now() - startedAt,
      },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return handleRequest(request);
}

export async function POST(request: NextRequest) {
  return handleRequest(request);
}