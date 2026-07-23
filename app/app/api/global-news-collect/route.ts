import { NextRequest, NextResponse } from "next/server";
import { GdeltNewsProvider } from "../../../collectors/global-news/gdelt-provider";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { saveSignal } from "../../../services/memory-engine";

const SOURCE_TYPE_CODE = "news_api";
const SOURCE_DOMAIN = "newsdata.io";

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

    if (createType