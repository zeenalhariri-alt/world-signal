import { supabaseAdmin } from "../lib/supabase-admin";

type JsonObject = Record<string, unknown>;

type DocumentRow = {
  id: string;
  title: string | null;
  raw_text: string | null;
  published_at: string | null;
  language_code: string | null;
  metadata: JsonObject | null;
};

type ExtractedEvent = {
  document_id: string;
  event_type: string;
  event_title: string;
  event_summary: string | null;
  country_code: string | null;
  country_name: string | null;
  city_name: string | null;
  region_name: string | null;
  sector: string | null;
  topic: string | null;
  people: string[];
  organizations: string[];
  locations: string[];
  keywords: string[];
  event_date: string | null;
  importance_score: number;
  confidence_score: number;
  extraction_method: string;
  extraction_version: string;
  metadata: JsonObject;
};

export type EventExtractionResult = {
  read: number;
  created: number;
  alreadyExists: number;
  failed: number;
  failures: Array<{
    documentId: string;
    error: string;
  }>;
};

const COUNTRY_ALIASES: Array<{
  code: string;
  name: string;
  aliases: string[];
}> = [
  {
    code: "BE",
    name: "Belgium",
    aliases: ["belgium", "belgian"],
  },
  {
    code: "SY",
    name: "Syria",
    aliases: ["syria", "syrian"],
  },
  {
    code: "US",
    name: "United States",
    aliases: [
      "united states",
      "united states of america",
      "u.s.",
      "u.s.a.",
      "usa",
      "american",
    ],
  },
  {
    code: "GB",
    name: "United Kingdom",
    aliases: [
      "united kingdom",
      "uk",
      "u.k.",
      "britain",
      "british",
      "england",
    ],
  },
  {
    code: "FR",
    name: "France",
    aliases: ["france", "french"],
  },
  {
    code: "DE",
    name: "Germany",
    aliases: ["germany", "german"],
  },
  {
    code: "NL",
    name: "Netherlands",
    aliases: ["netherlands", "dutch", "holland"],
  },
  {
    code: "TR",
    name: "Türkiye",
    aliases: ["türkiye", "turkey", "turkish"],
  },
  {
    code: "RU",
    name: "Russia",
    aliases: ["russia", "russian"],
  },
  {
    code: "UA",
    name: "Ukraine",
    aliases: ["ukraine", "ukrainian"],
  },
  {
    code: "CN",
    name: "China",
    aliases: ["china", "chinese"],
  },
  {
    code: "JP",
    name: "Japan",
    aliases: ["japan", "japanese"],
  },
  {
    code: "IN",
    name: "India",
    aliases: ["india", "indian"],
  },
  {
    code: "IR",
    name: "Iran",
    aliases: ["iran", "iranian"],
  },
  {
    code: "IQ",
    name: "Iraq",
    aliases: ["iraq", "iraqi"],
  },
  {
    code: "IL",
    name: "Israel",
    aliases: ["israel", "israeli"],
  },
  {
    code: "LB",
    name: "Lebanon",
    aliases: ["lebanon", "lebanese"],
  },
  {
    code: "JO",
    name: "Jordan",
    aliases: ["jordan", "jordanian"],
  },
  {
    code: "SA",
    name: "Saudi Arabia",
    aliases: ["saudi arabia", "saudi"],
  },
  {
    code: "AE",
    name: "United Arab Emirates",
    aliases: [
      "united arab emirates",
      "uae",
      "u.a.e.",
      "emirati",
    ],
  },
  {
    code: "QA",
    name: "Qatar",
    aliases: ["qatar", "qatari"],
  },
  {
    code: "EG",
    name: "Egypt",
    aliases: ["egypt", "egyptian"],
  },
  {
    code: "CA",
    name: "Canada",
    aliases: ["canada", "canadian"],
  },
  {
    code: "AU",
    name: "Australia",
    aliases: ["australia", "australian"],
  },
  {
    code: "BR",
    name: "Brazil",
    aliases: ["brazil", "brazilian"],
  },
  {
    code: "MX",
    name: "Mexico",
    aliases: ["mexico", "mexican"],
  },
  {
    code: "ZA",
    name: "South Africa",
    aliases: ["south africa", "south african"],
  },
];

const ORGANIZATION_SUFFIXES = [
  "Agency",
  "Authority",
  "Bank",
  "Committee",
  "Company",
  "Corporation",
  "Council",
  "Department",
  "Foundation",
  "Government",
  "Group",
  "Institute",
  "Ministry",
  "Organization",
  "Organisation",
  "Party",
  "Police",
  "University",
];

const PERSON_TITLE_PREFIXES = [
  "President",
  "Prime Minister",
  "Minister",
  "Secretary",
  "Governor",
  "Mayor",
  "General",
  "Dr",
  "Professor",
  "Judge",
  "Senator",
  "Representative",
];

const NON_PERSON_PHRASES = new Set([
  "United States",
  "United Kingdom",
  "European Union",
  "United Nations",
  "White House",
  "Supreme Court",
  "Prime Minister",
  "Foreign Minister",
  "Defense Minister",
  "World Bank",
  "Central Bank",
  "Middle East",
  "South Africa",
  "Saudi Arabia",
  "New York",
]);

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

  const cleaned = value.replace(/\s+/g, " ").trim();

  return cleaned.length > 0 ? cleaned : null;
}

function normalizeComparable(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}\s.'&-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const cleaned = cleanText(value);

    if (!cleaned) {
      continue;
    }

    const normalized = normalizeComparable(cleaned);

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(cleaned);
  }

  return result;
}

function extractStrings(value: unknown): string[] {
  if (typeof value === "string") {
    const cleaned = cleanText(value);
    return cleaned ? [cleaned] : [];
  }

  if (Array.isArray(value)) {
    return uniqueStrings(
      value.flatMap((item) => extractStrings(item)),
    );
  }

  if (!isRecord(value)) {
    return [];
  }

  const preferredKeys = [
    "name",
    "label",
    "title",
    "text",
    "value",
    "canonical_name",
    "canonicalName",
  ];

  for (const key of preferredKeys) {
    const extracted = extractStrings(value[key]);

    if (extracted.length > 0) {
      return extracted;
    }
  }

  return [];
}

function findMetadataValues(
  metadata: JsonObject | null,
  keys: string[],
): string[] {
  if (!metadata) {
    return [];
  }

  const wantedKeys = new Set(
    keys.map((key) => normalizeComparable(key)),
  );
  const results: string[] = [];
  const visited = new Set<object>();

  function visit(value: unknown, depth: number): void {
    if (depth > 5) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }

      return;
    }

    if (!isRecord(value) || visited.has(value)) {
      return;
    }

    visited.add(value);

    for (const [key, nestedValue] of Object.entries(value)) {
      const normalizedKey = normalizeComparable(key);

      if (wantedKeys.has(normalizedKey)) {
        results.push(...extractStrings(nestedValue));
      }

      visit(nestedValue, depth + 1);
    }
  }

  visit(metadata, 0);

  return uniqueStrings(results);
}

function detectEventType(text: string): string {
  const normalized = text.toLowerCase();

  if (
    normalized.includes("attack") ||
    normalized.includes("war") ||
    normalized.includes("missile") ||
    normalized.includes("airstrike") ||
    normalized.includes("strike") ||
    normalized.includes("bomb") ||
    normalized.includes("killed") ||
    normalized.includes("military")
  ) {
    return "conflict";
  }

  if (
    normalized.includes("election") ||
    normalized.includes("president") ||
    normalized.includes("government") ||
    normalized.includes("minister") ||
    normalized.includes("parliament") ||
    normalized.includes("policy") ||
    normalized.includes("vote")
  ) {
    return "politics";
  }

  if (
    normalized.includes("market") ||
    normalized.includes("stock") ||
    normalized.includes("inflation") ||
    normalized.includes("economy") ||
    normalized.includes("trade") ||
    normalized.includes("bank") ||
    normalized.includes("investment")
  ) {
    return "economy";
  }

  if (
    normalized.includes("fire") ||
    normalized.includes("earthquake") ||
    normalized.includes("flood") ||
    normalized.includes("crash") ||
    normalized.includes("storm") ||
    normalized.includes("explosion")
  ) {
    return "disaster";
  }

  if (
    normalized.includes("hospital") ||
    normalized.includes("disease") ||
    normalized.includes("health") ||
    normalized.includes("virus") ||
    normalized.includes("outbreak") ||
    normalized.includes("medical")
  ) {
    return "health";
  }

  if (
    normalized.includes("court") ||
    normalized.includes("judge") ||
    normalized.includes("arrest") ||
    normalized.includes("police") ||
    normalized.includes("trial")
  ) {
    return "law";
  }

  if (
    normalized.includes("technology") ||
    normalized.includes("software") ||
    normalized.includes(" ai ") ||
    normalized.startsWith("ai ") ||
    normalized.includes("artificial intelligence") ||
    normalized.includes("cyber")
  ) {
    return "technology";
  }

  return "general";
}

function detectSector(eventType: string): string {
  switch (eventType) {
    case "economy":
      return "economy";

    case "politics":
      return "government";

    case "conflict":
      return "security";

    case "health":
      return "healthcare";

    case "disaster":
      return "emergency";

    case "law":
      return "justice";

    case "technology":
      return "technology";

    default:
      return "general";
  }
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "that",
    "with",
    "from",
    "this",
    "have",
    "has",
    "was",
    "were",
    "will",
    "into",
    "after",
    "before",
    "over",
    "under",
    "more",
    "than",
    "says",
    "said",
    "about",
    "amid",
    "against",
    "could",
    "would",
    "their",
    "there",
    "they",
    "them",
    "been",
    "being",
    "also",
    "when",
    "where",
    "what",
    "which",
  ]);

  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(
      (word) =>
        word.length >= 4 &&
        !stopWords.has(word) &&
        !/^\d+$/u.test(word),
    );

  return uniqueStrings(words).slice(0, 15);
}

function detectImportanceScore(eventType: string): number {
  switch (eventType) {
    case "conflict":
      return 85;

    case "disaster":
      return 80;

    case "politics":
      return 70;

    case "economy":
      return 65;

    case "health":
      return 65;

    case "law":
      return 55;

    case "technology":
      return 50;

    default:
      return 40;
  }
}

function detectCountryFromText(text: string): {
  countryCode: string | null;
  countryName: string | null;
} {
  const normalizedText = ` ${normalizeComparable(text)} `;

  for (const country of COUNTRY_ALIASES) {
    const matched = country.aliases.some((alias) =>
      normalizedText.includes(
        ` ${normalizeComparable(alias)} `,
      ),
    );

    if (matched) {
      return {
        countryCode: country.code,
        countryName: country.name,
      };
    }
  }

  return {
    countryCode: null,
    countryName: null,
  };
}

function normalizeCountryCode(
  value: string | null,
): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();

  return /^[A-Z]{2}$/.test(normalized)
    ? normalized
    : null;
}

function resolveCountry(
  document: DocumentRow,
  combinedText: string,
): {
  countryCode: string | null;
  countryName: string | null;
} {
  const metadataCodes = findMetadataValues(
    document.metadata,
    [
      "country_code",
      "countryCode",
      "source_country_code",
      "sourceCountryCode",
    ],
  );

  const metadataNames = findMetadataValues(
    document.metadata,
    [
      "country",
      "country_name",
      "countryName",
      "source_country",
      "sourceCountry",
    ],
  );

  const metadataCode = normalizeCountryCode(
    metadataCodes[0] ?? null,
  );
  const metadataName = cleanText(metadataNames[0]);

  if (metadataCode || metadataName) {
    const aliasMatch = COUNTRY_ALIASES.find(
      (country) =>
        country.code === metadataCode ||
        country.aliases.some(
          (alias) =>
            normalizeComparable(alias) ===
            normalizeComparable(metadataName ?? ""),
        ),
    );

    return {
      countryCode: metadataCode ?? aliasMatch?.code ?? null,
      countryName:
        metadataName ?? aliasMatch?.name ?? null,
    };
  }

  return detectCountryFromText(combinedText);
}

function extractOrganizations(
  document: DocumentRow,
  text: string,
): string[] {
  const metadataOrganizations = findMetadataValues(
    document.metadata,
    [
      "organization",
      "organizations",
      "organisation",
      "organisations",
      "company",
      "companies",
      "institution",
      "institutions",
      "agency",
      "agencies",
    ],
  );

  const detected: string[] = [...metadataOrganizations];

  const acronymMatches =
    text.match(/\b[A-Z][A-Z0-9&.-]{2,10}\b/g) ?? [];

  detected.push(...acronymMatches);

  const suffixPattern = ORGANIZATION_SUFFIXES.join("|");
  const organizationPattern = new RegExp(
    String.raw`\b(?:[A-Z][\p{L}&'.-]*\s+){0,5}(?:${suffixPattern})\b`,
    "gu",
  );

  detected.push(
    ...(text.match(organizationPattern) ?? []),
  );

  return uniqueStrings(detected).slice(0, 20);
}

function extractPeople(
  document: DocumentRow,
  text: string,
  organizations: string[],
): string[] {
  const metadataPeople = findMetadataValues(
    document.metadata,
    [
      "person",
      "people",
      "persons",
      "author",
      "authors",
      "speaker",
      "speakers",
      "official",
      "officials",
    ],
  );

  const detected: string[] = [...metadataPeople];

  const titlePrefixPattern = PERSON_TITLE_PREFIXES.join("|");
  const titledPersonPattern = new RegExp(
    String.raw`\b(?:${titlePrefixPattern})\.?\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){1,3})`,
    "gu",
  );

  for (const match of text.matchAll(titledPersonPattern)) {
    if (match[1]) {
      detected.push(match[1]);
    }
  }

  const likelyPersonPattern =
    /\b[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){1,2}\b/gu;

  for (const match of text.matchAll(likelyPersonPattern)) {
    const candidate = match[0];

    if (NON_PERSON_PHRASES.has(candidate)) {
      continue;
    }

    const normalizedCandidate =
      normalizeComparable(candidate);

    const isOrganization = organizations.some(
      (organization) =>
        normalizeComparable(organization) ===
        normalizedCandidate,
    );

    if (!isOrganization) {
      detected.push(candidate);
    }
  }

  return uniqueStrings(detected).slice(0, 20);
}

function extractLocations(
  document: DocumentRow,
  text: string,
  countryName: string | null,
): {
  cityName: string | null;
  regionName: string | null;
  locations: string[];
} {
  const metadataCities = findMetadataValues(
    document.metadata,
    [
      "city",
      "city_name",
      "cityName",
      "town",
      "municipality",
    ],
  );

  const metadataRegions = findMetadataValues(
    document.metadata,
    [
      "region",
      "region_name",
      "regionName",
      "state",
      "province",
      "district",
      "governorate",
    ],
  );

  const metadataLocations = findMetadataValues(
    document.metadata,
    [
      "location",
      "locations",
      "place",
      "places",
      "geo",
      "geography",
    ],
  );

  const detectedLocations: string[] = [
    ...metadataLocations,
    ...metadataCities,
    ...metadataRegions,
  ];

  const locationPattern =
    /\b(?:in|at|near|outside|from|across)\s+([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,3})/gu;

  for (const match of text.matchAll(locationPattern)) {
    if (match[1]) {
      detectedLocations.push(match[1]);
    }
  }

  if (countryName) {
    detectedLocations.push(countryName);
  }

  return {
    cityName: cleanText(metadataCities[0]) ?? null,
    regionName: cleanText(metadataRegions[0]) ?? null,
    locations: uniqueStrings(detectedLocations).slice(0, 20),
  };
}

function buildEvent(document: DocumentRow): ExtractedEvent {
  const title = document.title?.trim() || "Untitled event";
  const summary = document.raw_text?.trim() || null;
  const combinedText = `${title} ${summary ?? ""}`.trim();

  const eventType = detectEventType(combinedText);
  const country = resolveCountry(document, combinedText);
  const organizations = extractOrganizations(
    document,
    combinedText,
  );
  const people = extractPeople(
    document,
    combinedText,
    organizations,
  );
  const locationData = extractLocations(
    document,
    combinedText,
    country.countryName,
  );

  return {
    document_id: document.id,
    event_type: eventType,
    event_title: title,
    event_summary: summary,
    country_code: country.countryCode,
    country_name: country.countryName,
    city_name: locationData.cityName,
    region_name: locationData.regionName,
    sector: detectSector(eventType),
    topic: eventType,
    people,
    organizations,
    locations: locationData.locations,
    keywords: extractKeywords(combinedText),
    event_date: document.published_at,
    importance_score: detectImportanceScore(eventType),
    confidence_score: 60,
    extraction_method: "rules-v2",
    extraction_version: "v2",
    metadata: {
      sourceLanguage: document.language_code,
      documentMetadata: document.metadata ?? {},
      entityExtraction: {
        peopleCount: people.length,
        organizationCount: organizations.length,
        locationCount: locationData.locations.length,
        countryDetected: Boolean(country.countryName),
        method: "metadata-and-rules",
      },
    },
  };
}

export async function extractPendingEvents(
  limit = 20,
): Promise<EventExtractionResult> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(
      "Event Extractor validation failed: limit must be an integer between 1 and 100.",
    );
  }

  const { data: documents, error: documentsError } =
    await supabaseAdmin
      .schema("ingest")
      .from("documents")
      .select(
        "id, title, raw_text, published_at, language_code, metadata",
      )
      .eq("processing_status", "received")
      .order("created_at", { ascending: true })
      .limit(limit);

  if (documentsError) {
    throw new Error(
      `Event Extractor document lookup failed: ${documentsError.message}`,
    );
  }

  const rows = (documents ?? []) as DocumentRow[];

  let created = 0;
  let alreadyExists = 0;

  const failures: Array<{
    documentId: string;
    error: string;
  }> = [];

  for (const document of rows) {
    try {
      const event = buildEvent(document);

      const { data: insertedEvent, error: eventError } =
        await supabaseAdmin
          .schema("core")
          .from("extracted_events")
          .upsert(event, {
            onConflict: "document_id",
            ignoreDuplicates: true,
          })
          .select("id")
          .maybeSingle();

      if (eventError) {
        throw new Error(
          `Event insert failed: ${eventError.message}`,
        );
      }

      if (insertedEvent?.id) {
        created += 1;
      } else {
        alreadyExists += 1;
      }

      const { error: updateError } = await supabaseAdmin
        .schema("ingest")
        .from("documents")
        .update({
          processing_status: "processed",
        })
        .eq("id", document.id);

      if (updateError) {
        throw new Error(
          `Document status update failed: ${updateError.message}`,
        );
      }
    } catch (error) {
      failures.push({
        documentId: document.id,
        error:
          error instanceof Error
            ? error.message
            : "Unknown extraction error",
      });
    }
  }

  return {
    read: rows.length,
    created,
    alreadyExists,
    failed: failures.length,
    failures,
  };
}