import { createHash } from "node:crypto";
import { supabaseAdmin } from "../lib/supabase-admin";

/* ============================================================
 * WORLD SIGNAL
 * Memory Engine V1
 *
 * Pipeline:
 * External source
 *   → ingest.documents
 *   → core.extracted_events
 *   → core.events
 *   → core.entities
 *   → core.event_entities
 * ============================================================
 */

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

type ExtractedEvent = {
  id: string;
  document_id: string;
  event_type: string | null;
  event_title: string;
  event_summary: string | null;
  country_code: string | null;
  country_name: string | null;
  city_name: string | null;
  region_name: string | null;
  sector: string | null;
  topic: string | null;
  people: unknown;
  organizations: unknown;
  locations: unknown;
  keywords: unknown;
  event_date: string | null;
  importance_score: number | string | null;
  confidence_score: number | string | null;
  extraction_method: string;
  extraction_version: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

type TypeRow = {
  id: string;
  code: string;
};

type StoredEntity = {
  id: string;
  entity_type_id: string;
  canonical_name: string;
  normalized_name: string | null;
  country_code: string | null;
};

type StoredCoreEvent = {
  id: string;
  canonical_title: string;
};

type EntityCandidate = {
  name: string;
  typeCode:
    | "person"
    | "company"
    | "organization"
    | "country"
    | "region"
    | "city"
    | "location"
    | "other";
  roleCode: string;
  isPrimary?: boolean;
  description?: string | null;
  attributes?: Record<string, unknown>;
};

export type SaveSignalResult = {
  status: "created" | "already_exists";
  document: StoredDocument;
};

export type ProcessExtractedEventResult = {
  status: "created" | "already_processed";
  extractedEventId: string;
  coreEventId: string;
  entitiesCreated: number;
  entitiesLinked: number;
};

export type MemoryBatchFailure = {
  extractedEventId: string;
  error: string;
};

export type MemoryBatchResult = {
  requested: number;
  processed: number;
  created: number;
  alreadyProcessed: number;
  failed: number;
  entitiesCreated: number;
  entitiesLinked: number;
  failures: MemoryBatchFailure[];
};

const DOCUMENT_SELECT =
  "id, source_id, title, canonical_url, processing_status, retrieved_at, created_at";

const EXTRACTED_EVENT_SELECT = [
  "id",
  "document_id",
  "event_type",
  "event_title",
  "event_summary",
  "country_code",
  "country_name",
  "city_name",
  "region_name",
  "sector",
  "topic",
  "people",
  "organizations",
  "locations",
  "keywords",
  "event_date",
  "importance_score",
  "confidence_score",
  "extraction_method",
  "extraction_version",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const MEMORY_VERSION = "core-memory-v1";

/* ============================================================
 * Generic helpers
 * ============================================================
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function readString(
  value: Record<string, unknown>,
  possibleKeys: string[],
): string | null {
  for (const key of possibleKeys) {
    const candidate = value[key];

    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCountryCode(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function toScore(
  value: number | string | null,
  fallback: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, parsed));
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function uniqueEntityCandidates(
  candidates: EntityCandidate[],
): EntityCandidate[] {
  const unique = new Map<string, EntityCandidate>();

  for (const candidate of candidates) {
    const normalized = normalizeName(candidate.name);

    if (!normalized) {
      continue;
    }

    const key = `${candidate.typeCode}:${normalized}`;

    const existing = unique.get(key);

    if (!existing) {
      unique.set(key, candidate);
      continue;
    }

    unique.set(key, {
      ...existing,
      isPrimary: existing.isPrimary || candidate.isPrimary,
      attributes: {
        ...(existing.attributes ?? {}),
        ...(candidate.attributes ?? {}),
      },
    });
  }

  return [...unique.values()];
}

/* ============================================================
 * Entity extraction helpers
 * ============================================================
 */

function extractNames(value: unknown): string[] {
  const names: string[] = [];

  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      const name = item.trim();

      if (name) {
        names.push(name);
      }

      return;
    }

    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }

      return;
    }

    if (!isRecord(item)) {
      return;
    }

    const name = readString(item, [
      "canonical_name",
      "canonicalName",
      "name",
      "title",
      "label",
      "value",
      "text",
    ]);

    if (name) {
      names.push(name);
    }
  };

  visit(value);

  return [...new Set(names)];
}

function extractOrganizationCandidates(
  value: unknown,
): EntityCandidate[] {
  const candidates: EntityCandidate[] = [];

  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      const name = item.trim();

      if (name) {
        candidates.push({
          name,
          typeCode: "organization",
          roleCode: "mentioned",
        });
      }

      return;
    }

    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child);
      }

      return;
    }

    if (!isRecord(item)) {
      return;
    }

    const name = readString(item, [
      "canonical_name",
      "canonicalName",
      "name",
      "title",
      "label",
      "value",
      "text",
    ]);

    if (!name) {
      return;
    }

    const rawType = readString(item, [
      "entity_type",
      "entityType",
      "type",
      "organization_type",
      "organizationType",
    ]);

    const normalizedType = rawType?.toLowerCase() ?? "";

    const typeCode =
      normalizedType.includes("company") ||
      normalizedType.includes("business") ||
      normalizedType.includes("corporation")
        ? "company"
        : "organization";

    candidates.push({
      name,
      typeCode,
      roleCode: "mentioned",
      attributes: {
        extracted_data: item,
      },
    });
  };

  visit(value);

  return candidates;
}

function buildEntityCandidates(
  extractedEvent: ExtractedEvent,
): EntityCandidate[] {
  const candidates: EntityCandidate[] = [];

  const countryCode = normalizeCountryCode(
    extractedEvent.country_code,
  );

  if (extractedEvent.country_name?.trim()) {
    candidates.push({
      name: extractedEvent.country_name.trim(),
      typeCode: "country",
      roleCode: "location",
      isPrimary:
        !extractedEvent.city_name &&
        !extractedEvent.region_name,
      attributes: {
        country_code: countryCode,
      },
    });
  }

  if (extractedEvent.region_name?.trim()) {
    candidates.push({
      name: extractedEvent.region_name.trim(),
      typeCode: "region",
      roleCode: "location",
      isPrimary: !extractedEvent.city_name,
      attributes: {
        country_code: countryCode,
      },
    });
  }

  if (extractedEvent.city_name?.trim()) {
    candidates.push({
      name: extractedEvent.city_name.trim(),
      typeCode: "city",
      roleCode: "location",
      isPrimary: true,
      attributes: {
        country_code: countryCode,
      },
    });
  }

  for (const personName of extractNames(extractedEvent.people)) {
    candidates.push({
      name: personName,
      typeCode: "person",
      roleCode: "mentioned",
    });
  }

  candidates.push(
    ...extractOrganizationCandidates(
      extractedEvent.organizations,
    ),
  );

  for (const locationName of extractNames(
    extractedEvent.locations,
  )) {
    candidates.push({
      name: locationName,
      typeCode: "location",
      roleCode: "location",
    });
  }

  return uniqueEntityCandidates(candidates);
}

/* ============================================================
 * Event type resolution
 * ============================================================
 */

function normalizeEventTypeCode(value: string | null): string {
  const normalized = normalizeName(value ?? "");

  const exactCodes = new Set([
    "business",
    "culture",
    "disaster",
    "economy",
    "environment",
    "general",
    "health",
    "law",
    "politics",
    "science",
    "security",
    "sports",
    "technology",
  ]);

  if (exactCodes.has(normalized)) {
    return normalized;
  }

  if (
    normalized.includes("business") ||
    normalized.includes("company") ||
    normalized.includes("trade")
  ) {
    return "business";
  }

  if (
    normalized.includes("economic") ||
    normalized.includes("economy") ||
    normalized.includes("price") ||
    normalized.includes("market") ||
    normalized.includes("finance")
  ) {
    return "economy";
  }

  if (
    normalized.includes("politic") ||
    normalized.includes("government") ||
    normalized.includes("election")
  ) {
    return "politics";
  }

  if (
    normalized.includes("security") ||
    normalized.includes("crime") ||
    normalized.includes("war") ||
    normalized.includes("conflict") ||
    normalized.includes("military")
  ) {
    return "security";
  }

  if (
    normalized.includes("health") ||
    normalized.includes("medical") ||
    normalized.includes("disease")
  ) {
    return "health";
  }

  if (
    normalized.includes("law") ||
    normalized.includes("legal") ||
    normalized.includes("regulation")
  ) {
    return "law";
  }

  if (
    normalized.includes("technology") ||
    normalized.includes("tech") ||
    normalized.includes("digital") ||
    normalized.includes("software")
  ) {
    return "technology";
  }

  if (
    normalized.includes("science") ||
    normalized.includes("research")
  ) {
    return "science";
  }

  if (
    normalized.includes("environment") ||
    normalized.includes("climate") ||
    normalized.includes("weather")
  ) {
    return "environment";
  }

  if (
    normalized.includes("disaster") ||
    normalized.includes("earthquake") ||
    normalized.includes("flood") ||
    normalized.includes("fire")
  ) {
    return "disaster";
  }

  if (
    normalized.includes("sport") ||
    normalized.includes("football") ||
    normalized.includes("match")
  ) {
    return "sports";
  }

  if (
    normalized.includes("culture") ||
    normalized.includes("art") ||
    normalized.includes("entertainment")
  ) {
    return "culture";
  }

  return "general";
}

async function loadTypeMap(
  tableName: "event_types" | "entity_types",
): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin
    .schema("core")
    .from(tableName)
    .select("id, code")
    .eq("is_active", true);

  if (error) {
    throw new Error(
      `Memory Engine could not load core.${tableName}: ${error.message}`,
    );
  }

  const rows = (data ?? []) as TypeRow[];

  return new Map(
    rows.map((row) => [
      String(row.code).toLowerCase(),
      row.id,
    ]),
  );
}

/* ============================================================
 * Raw document storage
 * ============================================================
 */

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
    throw new Error(
      `Memory Engine lookup failed: ${error.message}`,
    );
  }

  return data as StoredDocument | null;
}

export async function saveSignal(
  signal: SignalInput,
): Promise<SaveSignalResult> {
  const sourceId = signal.sourceId.trim();

  if (!sourceId) {
    throw new Error(
      "Memory Engine validation failed: sourceId is required.",
    );
  }

  const normalizedText = signal.rawText?.trim() ?? "";
  const canonicalUrl = signal.canonicalUrl?.trim() || null;
  const documentType =
    signal.documentType?.trim() || "article";

  if (canonicalUrl) {
    const existingDocument =
      await findDocumentByCanonicalUrl(canonicalUrl);

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
      content_type:
        signal.contentType ?? "application/json",
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
      const existingDocument =
        await findDocumentByCanonicalUrl(canonicalUrl);

      if (existingDocument) {
        return {
          status: "already_exists",
          document: existingDocument,
        };
      }
    }

    throw new Error(
      `Memory Engine failed [${
        error.code ?? "unknown"
      }]: ${error.message}`,
    );
  }

  if (!data) {
    throw new Error(
      "Memory Engine failed: document was inserted but no data was returned.",
    );
  }

  return {
    status: "created",
    document: data as StoredDocument,
  };
}

/* ============================================================
 * Entity resolution
 * ============================================================
 */

async function findOrCreateEntity(
  candidate: EntityCandidate,
  entityTypeMap: Map<string, string>,
  countryCode: string | null,
  detectedAt: string,
): Promise<{
  entity: StoredEntity;
  created: boolean;
}> {
  const entityTypeId = entityTypeMap.get(candidate.typeCode);

  if (!entityTypeId) {
    throw new Error(
      `Memory Engine entity type is missing: ${candidate.typeCode}`,
    );
  }

  const normalizedName = normalizeName(candidate.name);

  if (!normalizedName) {
    throw new Error(
      "Memory Engine cannot create an entity with an empty name.",
    );
  }

  let query = supabaseAdmin
    .schema("core")
    .from("entities")
    .select(
      "id, entity_type_id, canonical_name, normalized_name, country_code",
    )
    .eq("entity_type_id", entityTypeId)
    .eq("normalized_name", normalizedName);

  if (countryCode) {
    query = query.eq("country_code", countryCode);
  } else {
    query = query.is("country_code", null);
  }

  const { data: existingEntity, error: lookupError } =
    await query.limit(1).maybeSingle();

  if (lookupError) {
    throw new Error(
      `Memory Engine entity lookup failed for "${candidate.name}": ${lookupError.message}`,
    );
  }

  if (existingEntity) {
    const { error: updateError } = await supabaseAdmin
      .schema("core")
      .from("entities")
      .update({
        last_seen_at: detectedAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingEntity.id);

    if (updateError) {
      throw new Error(
        `Memory Engine entity update failed for "${candidate.name}": ${updateError.message}`,
      );
    }

    return {
      entity: existingEntity as StoredEntity,
      created: false,
    };
  }

  const { data: createdEntity, error: insertError } =
    await supabaseAdmin
      .schema("core")
      .from("entities")
      .insert({
        entity_type_id: entityTypeId,
        canonical_name: candidate.name.trim(),
        normalized_name: normalizedName,
        description: candidate.description ?? null,
        status: "active",
        country_code: countryCode,
        external_ids: {},
        attributes: candidate.attributes ?? {},
        first_seen_at: detectedAt,
        last_seen_at: detectedAt,
      })
      .select(
        "id, entity_type_id, canonical_name, normalized_name, country_code",
      )
      .single();

  if (insertError || !createdEntity) {
    throw new Error(
      `Memory Engine entity creation failed for "${candidate.name}": ${
        insertError?.message ?? "No entity returned."
      }`,
    );
  }

  return {
    entity: createdEntity as StoredEntity,
    created: true,
  };
}

async function linkEntityToEvent(
  eventId: string,
  entityId: string,
  candidate: EntityCandidate,
): Promise<boolean> {
  const { data: existingLink, error: lookupError } =
    await supabaseAdmin
      .schema("core")
      .from("event_entities")
      .select("id")
      .eq("event_id", eventId)
      .eq("entity_id", entityId)
      .eq("role_code", candidate.roleCode)
      .limit(1)
      .maybeSingle();

  if (lookupError) {
    throw new Error(
      `Memory Engine event-entity lookup failed: ${lookupError.message}`,
    );
  }

  if (existingLink) {
    return false;
  }

  const { error: insertError } = await supabaseAdmin
    .schema("core")
    .from("event_entities")
    .insert({
      event_id: eventId,
      entity_id: entityId,
      role_code: candidate.roleCode,
      role_description: null,
      is_primary: candidate.isPrimary ?? false,
      attributes: candidate.attributes ?? {},
    });

  if (insertError) {
    throw new Error(
      `Memory Engine event-entity link failed: ${insertError.message}`,
    );
  }

  return true;
}

/* ============================================================
 * Core event processing
 * ============================================================
 */

async function findExistingCoreEvent(
  extractedEventId: string,
): Promise<StoredCoreEvent | null> {
  const { data, error } = await supabaseAdmin
    .schema("core")
    .from("events")
    .select("id, canonical_title")
    .contains("attributes", {
      source_extracted_event_id: extractedEventId,
    })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(
      `Memory Engine event lookup failed: ${error.message}`,
    );
  }

  return data as StoredCoreEvent | null;
}

export async function processExtractedEvent(
  extractedEvent: ExtractedEvent,
  providedEventTypeMap?: Map<string, string>,
  providedEntityTypeMap?: Map<string, string>,
): Promise<ProcessExtractedEventResult> {
  const existingEvent = await findExistingCoreEvent(
    extractedEvent.id,
  );

  if (existingEvent) {
    return {
      status: "already_processed",
      extractedEventId: extractedEvent.id,
      coreEventId: existingEvent.id,
      entitiesCreated: 0,
      entitiesLinked: 0,
    };
  }

  const eventTypeMap =
    providedEventTypeMap ??
    (await loadTypeMap("event_types"));

  const entityTypeMap =
    providedEntityTypeMap ??
    (await loadTypeMap("entity_types"));

  const eventTypeCode = normalizeEventTypeCode(
    extractedEvent.event_type,
  );

  const eventTypeId =
    eventTypeMap.get(eventTypeCode) ??
    eventTypeMap.get("general");

  if (!eventTypeId) {
    throw new Error(
      "Memory Engine requires the general event type.",
    );
  }

  const detectedAt =
    extractedEvent.created_at ??
    new Date().toISOString();

  const countryCode = normalizeCountryCode(
    extractedEvent.country_code,
  );

  const candidates = buildEntityCandidates(extractedEvent);

  const resolvedEntities: Array<{
    candidate: EntityCandidate;
    entity: StoredEntity;
    created: boolean;
  }> = [];

  let primaryLocationEntityId: string | null = null;
  let entitiesCreated = 0;

  for (const candidate of candidates) {
    const candidateCountryCode =
      candidate.typeCode === "country"
        ? normalizeCountryCode(
            typeof candidate.attributes?.country_code ===
              "string"
              ? candidate.attributes.country_code
              : countryCode,
          )
        : countryCode;

    const result = await findOrCreateEntity(
      candidate,
      entityTypeMap,
      candidateCountryCode,
      detectedAt,
    );

    if (result.created) {
      entitiesCreated += 1;
    }

    if (
      candidate.isPrimary &&
      candidate.roleCode === "location"
    ) {
      primaryLocationEntityId = result.entity.id;
    }

    resolvedEntities.push({
      candidate,
      entity: result.entity,
      created: result.created,
    });
  }

  const confidenceScore = toScore(
    extractedEvent.confidence_score,
    0.5,
  );

  const importanceScore = toScore(
    extractedEvent.importance_score,
    0.5,
  );

  const attributes: Record<string, unknown> = {
    source_extracted_event_id: extractedEvent.id,
    source_document_id: extractedEvent.document_id,
    source_schema: "core",
    source_table: "extracted_events",
    memory_version: MEMORY_VERSION,
    original_event_type: extractedEvent.event_type,
    country_code: countryCode,
    country_name: extractedEvent.country_name,
    region_name: extractedEvent.region_name,
    city_name: extractedEvent.city_name,
    sector: extractedEvent.sector,
    topic: extractedEvent.topic,
    keywords: extractedEvent.keywords,
    extraction_method: extractedEvent.extraction_method,
    extraction_version: extractedEvent.extraction_version,
    extraction_metadata: extractedEvent.metadata ?? {},
  };

  const { data: createdEvent, error: eventInsertError } =
    await supabaseAdmin
      .schema("core")
      .from("events")
      .insert({
        event_type_id: eventTypeId,
        canonical_title: extractedEvent.event_title.trim(),
        summary: extractedEvent.event_summary,
        status: "preliminary",
        occurred_at_start: extractedEvent.event_date,
        occurred_at_end: null,
        time_precision: extractedEvent.event_date
          ? "exact"
          : "unknown",
        primary_location_entity_id:
          primaryLocationEntityId,
        confidence_score: confidenceScore,
        importance_score: importanceScore,
        attributes,
        first_detected_at: detectedAt,
        last_updated_at: detectedAt,
      })
      .select("id, canonical_title")
      .single();

  if (eventInsertError || !createdEvent) {
    throw new Error(
      `Memory Engine core event creation failed: ${
        eventInsertError?.message ??
        "No event was returned."
      }`,
    );
  }

  let entitiesLinked = 0;

  for (const resolved of resolvedEntities) {
    const linked = await linkEntityToEvent(
      createdEvent.id,
      resolved.entity.id,
      resolved.candidate,
    );

    if (linked) {
      entitiesLinked += 1;
    }
  }

  return {
    status: "created",
    extractedEventId: extractedEvent.id,
    coreEventId: createdEvent.id,
    entitiesCreated,
    entitiesLinked,
  };
}

export async function processExtractedEventById(
  extractedEventId: string,
): Promise<ProcessExtractedEventResult> {
  const normalizedId = extractedEventId.trim();

  if (!normalizedId) {
    throw new Error(
      "Memory Engine validation failed: extractedEventId is required.",
    );
  }

  const { data, error } = await supabaseAdmin
    .schema("core")
    .from("extracted_events")
    .select(EXTRACTED_EVENT_SELECT)
    .eq("id", normalizedId)
    .single();

  if (error || !data) {
    throw new Error(
      `Memory Engine could not load extracted event ${normalizedId}: ${
        error?.message ?? "No event returned."
      }`,
    );
  }

 return processExtractedEvent(
  data as unknown as ExtractedEvent,
);
}

/* ============================================================
 * Batch processor
 * ============================================================
 */

export async function processPendingExtractedEvents(
  requestedLimit = 20,
): Promise<MemoryBatchResult> {
  const limit = Math.min(
    100,
    Math.max(1, Math.trunc(requestedLimit)),
  );

  const [eventTypeMap, entityTypeMap] = await Promise.all([
    loadTypeMap("event_types"),
    loadTypeMap("entity_types"),
  ]);

  const { data, error } = await supabaseAdmin
    .schema("core")
    .from("extracted_events")
    .select(EXTRACTED_EVENT_SELECT)
    .order("created_at", {
      ascending: false,
    })
    .limit(limit);

  if (error) {
    throw new Error(
      `Memory Engine could not load extracted events: ${error.message}`,
    );
  }

 const extractedEvents =
  (data ?? []) as unknown as ExtractedEvent[];

  const result: MemoryBatchResult = {
    requested: limit,
    processed: 0,
    created: 0,
    alreadyProcessed: 0,
    failed: 0,
    entitiesCreated: 0,
    entitiesLinked: 0,
    failures: [],
  };

  for (const extractedEvent of extractedEvents) {
    try {
      const processingResult =
        await processExtractedEvent(
          extractedEvent,
          eventTypeMap,
          entityTypeMap,
        );

      result.processed += 1;
      result.entitiesCreated +=
        processingResult.entitiesCreated;
      result.entitiesLinked +=
        processingResult.entitiesLinked;

      if (processingResult.status === "created") {
        result.created += 1;
      } else {
        result.alreadyProcessed += 1;
      }
    } catch (error) {
      result.failed += 1;
      result.failures.push({
        extractedEventId: extractedEvent.id,
        error: getErrorMessage(error),
      });
    }
  }

  return result;
}