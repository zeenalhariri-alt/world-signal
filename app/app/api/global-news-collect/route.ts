import { NextRequest, NextResponse } from "next/server";
import { GdeltNewsProvider } from "../../../collectors/global-news/gdelt-provider";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { saveSignal } from "../../../services/memory-engine";

const SOURCE_TYPE_CODE = "news_api";
const SOURCE_DOMAIN = "newsdata.io";
const SOURCE_NAME = "NewsData.io";

type TargetCountry = {
  countryCode?: string;
  countryName?: string;
};

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

async function getNewsDataSourceId(): Promise<string> {
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
          name: "News API",
          description: "Machine-readable news API provider",
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
        name: SOURCE_NAME,
        legal_name: SOURCE_NAME,
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

  return {
    value: raw,
  };
}

function readTargetCountry(raw: unknown): TargetCountry {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw)
  ) {
    return {};
  }

  const rawObject = raw as Record<string, unknown>;
  const worldSignal = rawObject.worldSignal;

  if (
    typeof worldSignal !== "object" ||
    worldSignal === null ||
    Array.isArray(worldSignal)
  ) {
    return {};
  }

  const worldSignalData =
    worldSignal as Record<string, unknown>;

  const countryCode =
    typeof worldSignalData.targetCountryCode === "string"
      ? worldSignalData.targetCountryCode.trim().toUpperCase()
      : undefined;

  const countryName =
    typeof worldSignalData.targetCountryName === "string"
      ? worldSignalData.targetCountryName.trim()
      : undefined;

  return {
    countryCode:
      countryCode && countryCode.length > 0
        ? countryCode
        : undefined,
    countryName:
      countryName && countryName.length > 0
        ? countryName
        : undefined,
  };
}

function createMetadata(
  providerName: string,
  originalSource: string,
  targetCountry: TargetCountry,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    provider: providerName,
    originalSource,
    collector: "newsdata-country",
  };

  if (targetCountry.countryCode) {
    metadata.countryCode = targetCountry.countryCode;
  }

  if (targetCountry.countryName) {
    metadata.countryName = targetCountry.countryName;
  }

  return metadata;
}

async function handleRequest(request: NextRequest) {
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json(
        {
          success: false,
          error: "Unauthorized",
        },
        {
          status: 401,
        },
      );
    }

    const sourceId = await getNewsDataSourceId();

    const provider = new GdeltNewsProvider();
    const items = await provider.fetchLatest();

    let created = 0;
    let alreadyExists = 0;
    let syriaItems = 0;
    let belgiumItems = 0;
    let unknownCountryItems = 0;

    const failures: Array<{
      url: string;
      error: string;
    }> = [];

    for (const item of items) {
      try {
        const targetCountry = readTargetCountry(item.raw);

        if (targetCountry.countryCode === "SY") {
          syriaItems += 1;
        } else if (targetCountry.countryCode === "BE") {
          belgiumItems += 1;
        } else {
          unknownCountryItems += 1;
        }

        const result = await saveSignal({
          sourceId,
          externalId: item.id,
          canonicalUrl: item.url,
          documentType: "article",
          title: item.title,
          authorText: item.source,
          languageCode: item.language ?? undefined,
          contentType: "application/json",
          publishedAt: item.publishedAt,
          rawText: item.summary ?? item.title,
          rawPayload: normalizeRawPayload(item.raw),
          metadata: createMetadata(
            provider.name,
            item.source,
            targetCountry,
          ),
        });

        if (result.status === "created") {
          created += 1;
        } else {
          alreadyExists += 1;
        }
      } catch (error) {
        failures.push({
          url: item.url,
          error:
            error instanceof Error
              ? error.message
              : "Unknown item collection error",
        });
      }
    }

    return NextResponse.json({
      success: true,
      provider: provider.name,
      sourceId,
      fetched: items.length,
      countries: {
        Syria: syriaItems,
        Belgium: belgiumItems,
        unknown: unknownCountryItems,
      },
      created,
      alreadyExists,
      failed: failures.length,
      failures,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown global news collection error",
      },
      {
        status: 500,
      },
    );
  }
}

export async function GET(request: NextRequest) {
  return handleRequest(request);
}

export async function POST(request: NextRequest) {
  return handleRequest(request);
}