import { NextRequest, NextResponse } from "next/server";
import { extractEntitiesFromEvents } from "../../../services/entity-extractor";

function isAuthorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    throw new Error("CRON_SECRET is missing.");
  }

  return request.headers.get("x-cron-secret") === cronSecret;
}

function readLimit(request: NextRequest): number {
  const rawLimit = request.nextUrl.searchParams.get("limit");

  if (rawLimit === null) {
    return 50;
  }

  const limit = Number(rawLimit);

  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error(
      "The limit must be an integer between 1 and 200.",
    );
  }

  return limit;
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

    const limit = readLimit(request);
    const result = await extractEntitiesFromEvents(limit);

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown entity extraction error",
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
