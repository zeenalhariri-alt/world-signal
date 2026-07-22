
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    message: "World Signal is alive",
    heartbeat: 1,
    created_at: new Date().toISOString(),
  });
}