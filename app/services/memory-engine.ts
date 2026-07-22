import { createHash } from "node:crypto";
import { supabaseAdmin } from "../lib/supabase-admin";

export type SignalInput = {
  sourceId: string;
  externalId?: string;
  canonicalUrl?: string;
  documentType?: string;
  title?: string;
  authorText?: string;
  languageCode?: string;
  contentType?: string;
  publishedAt?: string;
  modifiedAt?: string;
  rawText?: string;
  rawPayload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type StoredDocument = {
  id: string;
  source_id: string;
  title: string | null;
  canonical_url: string | null;
  processing_status: string;
  retrieved_at: string | null;
  created_at: string;
};

export type SaveSignalResult = {
  status: "created" | "already_exists";
  document: StoredDocument;
};

const DOCUMENT_SELECT =
  "id, source_id, title, canonical_url, processing_status, retrieved_at, created_at";

async function findDocumentByCanonicalUrl(
  canonicalUrl: string,
): Promise<StoredDocument | null> {
  const { data, error } = await supabaseAdmin
    .schema("ingest")
    .from("documents")
    .select(DOCUMENT_SELECT)
    .eq("canonical_url", canonicalUrl)
    .maybeSingle();

  if (error) {
    throw new Error(`Memory Engine lookup failed: ${error.message}`);
  }

  return data;
}

export async function saveSignal(
  signal: SignalInput,
): Promise<SaveSignalResult> {
  const sourceId = signal.sourceId.trim();

  if (!sourceId) {
    throw new Error("Memory Engine validation failed: sourceId is required.");
  }

  const normalizedText = signal.rawText?.trim() ?? "";
  const canonicalUrl = signal.canonicalUrl?.trim() || null;
  const documentType = signal.documentType?.trim() || "article";

  if (canonicalUrl) {
    const existingDocument = await findDocumentByCanonicalUrl(canonicalUrl);

    if (existingDocument) {
      return {
        status: "already_exists",
        document: existingDocument,
      };
    }
  }

  const hashMaterial = JSON.stringify({
    sourceId,
    externalId: signal.externalId ?? null,
    canonicalUrl,
    title: signal.title ?? null,
    publishedAt: signal.publishedAt ?? null,
    rawText: normalizedText,
  });

  const contentHash = createHash("sha256")
    .update(hashMaterial)
    .digest("hex");

  const { data, error } = await supabaseAdmin
    .schema("ingest")
    .from("documents")
    .insert({
      source_id: sourceId,
      external_id: signal.externalId ?? null,
      canonical_url: canonicalUrl,
      document_type: documentType,
      title: signal.title ?? null,
      author_text: signal.authorText ?? null,
      language_code: signal.languageCode ?? null,
      content_type: signal.contentType ?? "application/json",
      published_at: signal.publishedAt ?? null,
      modified_at: signal.modifiedAt ?? null,
      raw_text: normalizedText || null,
      raw_payload: signal.rawPayload ?? {},
      content_hash: contentHash,
      processing_status: "received",
      metadata: signal.metadata ?? {},
    })
    .select(DOCUMENT_SELECT)
    .single();

  if (error) {
    if (error.code === "23505" && canonicalUrl) {
      const existingDocument = await findDocumentByCanonicalUrl(canonicalUrl);

      if (existingDocument) {
        return {
          status: "already_exists",
          document: existingDocument,
        };
      }
    }

    throw new Error(
      `Memory Engine failed [${error.code ?? "unknown"}]: ${error.message}`,
    );
  }

  if (!data) {
    throw new Error(
      "Memory Engine failed: document was inserted but no data was returned.",
    );
  }

  return {
    status: "created",
    document: data,
  };
}