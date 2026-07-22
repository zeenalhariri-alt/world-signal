import { NextResponse } from "next/server";
import { saveSignal } from "../../../services/memory-engine";

const WORLD_SIGNAL_SOURCE_ID = "26abf0cf-418d-431d-96fd-323ab5cb2ab3";

export async function GET() {
  try {
    const result = await saveSignal({
      sourceId: WORLD_SIGNAL_SOURCE_ID,
      externalId: `first-pulse-${Date.now()}`,
      canonicalUrl: "world-signal://first-pulse",
      documentType: "system_pulse",
      title: "The First Pulse",
      authorText: "World Signal",
      languageCode: "en",
      contentType: "text/plain",
      publishedAt: new Date().toISOString(),
      rawText: "This is the first permanent memory stored by World Signal.",
      rawPayload: {
        event: "first_pulse",
      },
      metadata: {
        source: "memory-test",
      },
    });

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}