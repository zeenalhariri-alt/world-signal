import { NextResponse } from "next/server";
import { GdeltNewsProvider } from "../../../collectors/global-news/gdelt-provider";

export async function GET() {
  try {
    const provider = new GdeltNewsProvider();
    const items = await provider.fetchLatest();

    return NextResponse.json({
      success: true,
      provider: provider.name,
      count: items.length,
      items: items.slice(0, 5),
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