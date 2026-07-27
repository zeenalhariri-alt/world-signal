import { supabaseAdmin } from "../lib/supabase-admin";

type JsonObject = Record<string, unknown>;

type ExtractedEventRow = {
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
  metadata: JsonObject | null;
  created_at: string;
};

type EntityTypeRow = {
  id: string;
  code: string;
};

type EventTypeRow = {
  id: string;
  code: string;
};

type EntityCandidate = {
  typeCode:
    | "person"
    | "organization"
    | "country"
    | "city"
    | "region"
    | "location";
  canonicalName: string;
  countryCode: string | null;
  roleCode: string;
  roleDescription: string;
  isPrimary: boolean;
  attributes: JsonObject;
};

type ProcessingFailure = {
  extractedEventId: string;
  stage: string;
  error: string;
};

type EntityExtractorResult = {
  read: number;
  eventsCreated: number;
  eventsExisting: number;
  entitiesCreated: number;
  entitiesExisting: number;
  linksCreated: number;
  linksExisting: number;
  skippedCandidates: number;
  failed: number;
  failures: ProcessingFailure[];
};

const ENTITY_TYPE_CODES = [
  "person",
  "organization",
  "country",
  "city",
  "region",
  "location",
] as const;

const EVENT_TYPE_FALLBACK = "general";

function isRecord(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const cleaned = value
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

function normalizeName(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}\s.'&-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCountryCode(
  value: string | null,
): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();

  if (!/^[A-Z]{2}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function toFiniteNumber(
  value: number | string | null,
): number | null {
  if (value === null) {
    return null;
  }

  const parsed =
    typeof value === "number"
      ? value
      : Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function clampScore(
  value: number | string | null,
): number | null {
  const parsed = toFiniteNumber(value);

  if (parsed === null) {
    return null;
  }

  return Math.max(0, Math.min(1, parsed / 100));
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = normalizeName(value);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(value);
  }

  return result;
}

function extractNamesFromUnknown(value: unknown): string[] {
  if (typeof value === "string") {
    const cleaned = cleanText(value);
    return cleaned ? [cleaned] : [];
  }

  if (Array.isArray(value)) {
    const names: string[] = [];

    for (const item of value) {
      names.push(...extractNamesFromUnknown(item));
    }

    return uniqueStrings(names);
  }

  if (!isRecord(value)) {
    return [];
  }

  const preferredKeys = [
    "name",
    "canonical_name",
    "canonicalName",
    "title",
    "label",
    "text",
    "value",
  ];

  for (const key of preferredKeys) {
    const candidate = cleanText(value[key]);

    if (candidate) {
      return [candidate];
    }
  }

  return [];
}

function buildCandidates(
  event: ExtractedEventRow,
): EntityCandidate[] {
  const candidates: EntityCandidate[] = [];
  const countryCode = normalizeCountryCode(
    event.country_code,
  );

  const people = extractNamesFromUnknown(event.people);
  const organizations = extractNamesFromUnknown(
    event.organizations,
  );
  const locations = extractNamesFromUnknown(
    event.locations,
  );

  for (const person of people) {
    candidates.push({
      typeCode: "person",
      canonicalName: person,
      countryCode: null,
      roleCode: "mentioned",
      roleDescription: "Person mentioned in extracted event",
      isPrimary: false,
      attributes: {
        sourceField: "people",
      },
    });
  }

  for (const organization of organizations) {
    candidates.push({
      typeCode: "organization",
      canonicalName: organization,
      countryCode: null,
      roleCode: "mentioned",
      roleDescription:
        "Organization mentioned in extracted event",
      isPrimary: false,
      attributes: {
        sourceField: "organizations",
      },
    });
  }

  const countryName = cleanText(event.country_name);

  if (countryName) {
    candidates.push({
      typeCode: "country",
      canonicalName: countryName,
      countryCode,
      roleCode: "location",
      roleDescription: "Country associated with event",
      isPrimary:
        !cleanText(event.city_name) &&
        !cleanText(event.region_name),
      attributes: {
        sourceField: "country_name",
      },
    });
  }

  const cityName = cleanText(event.city_name);

  if (cityName) {
    candidates.push({
      typeCode: "city",
      canonicalName: cityName,
      countryCode,
      roleCode: "location",
      roleDescription: "City associated with event",
      isPrimary: true,
      attributes: {
        sourceField: "city_name",
      },
    });
  }

  const regionName = cleanText(event.region_name);

  if (regionName) {
    candidates.push({
      typeCode: "region",
      canonicalName: regionName,
      countryCode,
      roleCode: "location",
      roleDescription: "Region associated with event",
      isPrimary: !cityName,
      attributes: {
        sourceField: "region_name",
      },
    });
  }

  for (const location of locations) {
    const normalizedLocation = normalizeName(location);

    const duplicatesStructuredLocation =
      normalizedLocation === normalizeName(countryName ?? "") ||
      normalizedLocation === normalizeName(cityName ?? "") ||
      normalizedLocation === normalizeName(regionName ?? "");

    if (duplicatesStructuredLocation) {
      continue;
    }

    candidates.push({
      typeCode: "location",
      canonicalName: location,
      countryCode,
      roleCode: "location",
      roleDescription:
        "Location mentioned in extracted event",
      isPrimary:
        !cityName &&
        !regionName &&
        !countryName,
      attributes: {
        sourceField: "locations",
      },
    });
  }

  const uniqueCandidates = new Map<
    string,
    EntityCandidate
  >();

  for (const candidate of candidates) {
    const normalized = normalizeName(
      candidate.canonicalName,
    );

    if (!normalized) {
      continue;
    }

    const key = `${candidate.typeCode}:${normalized}`;

    const existing = uniqueCandidates.get(key);

    if (!existing) {
      uniqueCandidates.set(key, candidate);
      continue;
    }

    if (candidate.isPrimary && !existing.isPrimary) {
      uniqueCandidates.set(key, candidate);
    }
  }

  return [...uniqueCandidates.values()];
}

function normalizeEventTypeCode(
  event: ExtractedEventRow,
  validCodes: Set<string>,
): string {
  const candidates = [
    event.event_type,
    event.sector,
    event.topic,
  ];

  for (const candidate of candidates) {
    const cleaned = cleanText(candidate);

    if (!cleaned) {
      continue;
    }

    const normalized = normalizeName(cleaned)
      .replace(/\s+/g, "_")
      .replace(/-+/g, "_");

    if (validCodes.has(normalized)) {
      return normalized;
    }
  }

  return EVENT_TYPE_FALLBACK;
}

async function loadEntityTypes(): Promise<
  Map<string, string>
> {
  const { data, error } = await supabaseAdmin
    .schema("core")
    .from("entity_types")
    .select("id, code")
    .eq("is_active", true);

  if (error) {
    throw new Error(
      `Entity type lookup failed: ${error.message}`,
    );
  }

  const rows = (data ?? []) as EntityTypeRow[];
  const typeMap = new Map<string, string>();

  for (const row of rows) {
    typeMap.set(String(row.code).toLowerCase(), row.id);
  }

  const missingCodes = ENTITY_TYPE_CODES.filter(
    (code) => !typeMap.has(code),
  );

  if (missingCodes.length > 0) {
    throw new Error(
      `Required entity types are missing: ${missingCodes.join(
        ", ",
      )}`,
    );
  }

  return typeMap;
}

async function loadEventTypes(): Promise<
  Map<string, string>
> {
  const { data, error } = await supabaseAdmin
    .schema("core")
    .from("event_types")
    .select("id, code");

  if (error) {
    throw new Error(
      `Event type lookup failed: ${error.message}`,
    );
  }

  const rows = (data ?? []) as EventTypeRow[];
  const typeMap = new Map<string, string>();

  for (const row of rows) {
    typeMap.set(String(row.code).toLowerCase(), row.id);
  }

  if (!typeMap.has(EVENT_TYPE_FALLBACK)) {
    throw new Error(
      `Required event type "${EVENT_TYPE_FALLBACK}" is missing.`,
    );
  }

  return typeMap;
}

async function findOrCreateCoreEvent(
  extractedEvent: ExtractedEventRow,
  eventTypeMap: Map<string, string>,
): Promise<{
  eventId: string;
  created: boolean;
}> {
  const { data: existingEvents, error: lookupError } =
    await supabaseAdmin
      .schema("core")
      .from("events")
      .select("id")
      .contains("attributes", {
        extracted_event_id: extractedEvent.id,
      })
      .limit(1);

  if (lookupError) {
    throw new Error(
      `Core event lookup failed: ${lookupError.message}`,
    );
  }

  const existingEvent = existingEvents?.[0] as
    | { id: string }
    | undefined;

  if (existingEvent?.id) {
    return {
      eventId: existingEvent.id,
      created: false,
    };
  }

  const validCodes = new Set(eventTypeMap.keys());
  const eventTypeCode = normalizeEventTypeCode(
    extractedEvent,
    validCodes,
  );

  const eventTypeId =
    eventTypeMap.get(eventTypeCode) ??
    eventTypeMap.get(EVENT_TYPE_FALLBACK);

  if (!eventTypeId) {
    throw new Error(
      "Unable to resolve a valid event type ID.",
    );
  }

  const confidenceScore = clampScore(
    extractedEvent.confidence_score,
  );
  const importanceScore = clampScore(
    extractedEvent.importance_score,
  );

  const { data: insertedEvent, error: insertError } =
    await supabaseAdmin
      .schema("core")
      .from("events")
      .insert({
        event_type_id: eventTypeId,
        canonical_title: extractedEvent.event_title,
        summary: extractedEvent.event_summary,
        status: "preliminary",
        occurred_at_start: extractedEvent.event_date,
        occurred_at_end: null,
        time_precision: extractedEvent.event_date
          ? "exact"
          : "unknown",
        confidence_score: confidenceScore,
        importance_score: importanceScore,
        attributes: {
          extracted_event_id: extractedEvent.id,
          document_id: extractedEvent.document_id,
          extraction_method: "structured-fields-v1",
          original_event_type:
            extractedEvent.event_type,
          sector: extractedEvent.sector,
          topic: extractedEvent.topic,
          source_metadata:
            extractedEvent.metadata ?? {},
        },
      })
      .select("id")
      .single();

  if (insertError) {
    throw new Error(
      `Core event creation failed: ${insertError.message}`,
    );
  }

  if (!insertedEvent?.id) {
    throw new Error(
      "Core event creation returned no ID.",
    );
  }

  return {
    eventId: insertedEvent.id,
    created: true,
  };
}

async function findOrCreateEntity(
  candidate: EntityCandidate,
  entityTypeId: string,
  extractedEvent: ExtractedEventRow,
): Promise<{
  entityId: string;
  created: boolean;
}> {
  const normalizedName = normalizeName(
    candidate.canonicalName,
  );

  if (!normalizedName) {
    throw new Error("Entity name is empty after normalization.");
  }

  let query = supabaseAdmin
    .schema("core")
    .from("entities")
    .select("id")
    .eq("entity_type_id", entityTypeId)
    .eq("normalized_name", normalizedName);

  if (candidate.countryCode) {
    query = query.eq(
      "country_code",
      candidate.countryCode,
    );
  } else {
    query = query.is("country_code", null);
  }

  const { data: existingEntities, error: lookupError } =
    await query.limit(1);

  if (lookupError) {
    throw new Error(
      `Entity lookup failed for "${candidate.canonicalName}": ${lookupError.message}`,
    );
  }

  const existingEntity = existingEntities?.[0] as
    | { id: string }
    | undefined;

  if (existingEntity?.id) {
    const { error: updateError } = await supabaseAdmin
      .schema("core")
      .from("entities")
      .update({
        last_seen_at: new Date().toISOString(),
      })
      .eq("id", existingEntity.id);

    if (updateError) {
      throw new Error(
        `Entity last_seen_at update failed for "${candidate.canonicalName}": ${updateError.message}`,
      );
    }

    return {
      entityId: existingEntity.id,
      created: false,
    };
  }

  const now = new Date().toISOString();

  const { data: insertedEntity, error: insertError } =
    await supabaseAdmin
      .schema("core")
      .from("entities")
      .insert({
        entity_type_id: entityTypeId,
        canonical_name: candidate.canonicalName,
        normalized_name: normalizedName,
        description: null,
        status: "active",
        country_code: candidate.countryCode,
        external_ids: {},
        attributes: {
          extraction_method: "structured-fields-v1",
          first_extracted_event_id: extractedEvent.id,
          source_field:
            candidate.attributes.sourceField ?? null,
        },
        first_seen_at:
          extractedEvent.event_date ?? now,
        last_seen_at:
          extractedEvent.event_date ?? now,
      })
      .select("id")
      .single();

  if (insertError) {
    throw new Error(
      `Entity creation failed for "${candidate.canonicalName}": ${insertError.message}`,
    );
  }

  if (!insertedEntity?.id) {
    throw new Error(
      `Entity creation returned no ID for "${candidate.canonicalName}".`,
    );
  }

  return {
    entityId: insertedEntity.id,
    created: true,
  };
}

async function linkEventEntity(
  eventId: string,
  entityId: string,
  candidate: EntityCandidate,
  extractedEventId: string,
): Promise<{
  created: boolean;
}> {
  const { data: existingLinks, error: lookupError } =
    await supabaseAdmin
      .schema("core")
      .from("event_entities")
      .select("id")
      .eq("event_id", eventId)
      .eq("entity_id", entityId)
      .eq("role_code", candidate.roleCode)
      .limit(1);

  if (lookupError) {
    throw new Error(
      `Event-entity link lookup failed: ${lookupError.message}`,
    );
  }

  const existingLink = existingLinks?.[0] as
    | { id: string }
    | undefined;

  if (existingLink?.id) {
    return { created: false };
  }

  const { error: insertError } = await supabaseAdmin
    .schema("core")
    .from("event_entities")
    .insert({
      event_id: eventId,
      entity_id: entityId,
      role_code: candidate.roleCode,
      role_description: candidate.roleDescription,
      is_primary: candidate.isPrimary,
      attributes: {
        extracted_event_id: extractedEventId,
        source_field:
          candidate.attributes.sourceField ?? null,
        extraction_method: "structured-fields-v1",
      },
    });

  if (insertError) {
    throw new Error(
      `Event-entity link creation failed: ${insertError.message}`,
    );
  }

  return { created: true };
}

async function setPrimaryLocation(
  eventId: string,
  entityId: string,
): Promise<void> {
  const { error } = await supabaseAdmin
    .schema("core")
    .from("events")
    .update({
      primary_location_entity_id: entityId,
      last_updated_at: new Date().toISOString(),
    })
    .eq("id", eventId)
    .is("primary_location_entity_id", null);

  if (error) {
    throw new Error(
      `Primary event location update failed: ${error.message}`,
    );
  }
}

export async function extractEntitiesFromEvents(
  limit = 20,
): Promise<EntityExtractorResult> {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200
  ) {
    throw new Error(
      "Entity extraction limit must be an integer between 1 and 200.",
    );
  }

  const entityTypeMap = await loadEntityTypes();
  const eventTypeMap = await loadEventTypes();

  const { data, error } = await supabaseAdmin
    .schema("core")
    .from("pending_extracted_events")
    .select(
      [
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
        "metadata",
        "created_at",
      ].join(","),
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(
      `Extracted event lookup failed: ${error.message}`,
    );
  }

  const rows = (data ?? []) as unknown as ExtractedEventRow[];

  const result: EntityExtractorResult = {
    read: rows.length,
    eventsCreated: 0,
    eventsExisting: 0,
    entitiesCreated: 0,
    entitiesExisting: 0,
    linksCreated: 0,
    linksExisting: 0,
    skippedCandidates: 0,
    failed: 0,
    failures: [],
  };

  for (const extractedEvent of rows) {
    try {
      const coreEvent = await findOrCreateCoreEvent(
        extractedEvent,
        eventTypeMap,
      );

      if (coreEvent.created) {
        result.eventsCreated += 1;
      } else {
        result.eventsExisting += 1;
      }

      const candidates = buildCandidates(extractedEvent);

      if (candidates.length === 0) {
        result.skippedCandidates += 1;
        continue;
      }

      let primaryLocationEntityId: string | null = null;

      for (const candidate of candidates) {
        try {
          const entityTypeId = entityTypeMap.get(
            candidate.typeCode,
          );

          if (!entityTypeId) {
            throw new Error(
              `Missing entity type ID for ${candidate.typeCode}.`,
            );
          }

          const entity = await findOrCreateEntity(
            candidate,
            entityTypeId,
            extractedEvent,
          );

          if (entity.created) {
            result.entitiesCreated += 1;
          } else {
            result.entitiesExisting += 1;
          }

          const link = await linkEventEntity(
            coreEvent.eventId,
            entity.entityId,
            candidate,
            extractedEvent.id,
          );

          if (link.created) {
            result.linksCreated += 1;
          } else {
            result.linksExisting += 1;
          }

          if (
            candidate.isPrimary &&
            candidate.roleCode === "location" &&
            !primaryLocationEntityId
          ) {
            primaryLocationEntityId = entity.entityId;
          }
        } catch (candidateError) {
          result.failed += 1;

          result.failures.push({
            extractedEventId: extractedEvent.id,
            stage: `candidate:${candidate.typeCode}:${candidate.canonicalName}`,
            error:
              candidateError instanceof Error
                ? candidateError.message
                : "Unknown entity candidate error",
          });
        }
      }

      if (primaryLocationEntityId) {
        await setPrimaryLocation(
          coreEvent.eventId,
          primaryLocationEntityId,
        );
      }
    } catch (eventError) {
      result.failed += 1;

      result.failures.push({
        extractedEventId: extractedEvent.id,
        stage: "event",
        error:
          eventError instanceof Error
            ? eventError.message
            : "Unknown entity extraction error",
      });
    }
  }

  return result;
}