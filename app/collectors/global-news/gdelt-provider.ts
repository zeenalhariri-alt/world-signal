import type {
  GlobalNewsItem,
  GlobalNewsProvider,
} from "./provider";

const NEWSDATA_ENDPOINT = "https://newsdata.io/api/1/latest";

type TargetCountry = {
  code: "sy" | "be";
  name: "Syria" | "Belgium";
};

const TARGET_COUNTRIES: readonly TargetCountry[] = [
  {
    code: "sy",
    name: "Syria",
  },
  {
    code: "be",
    name: "Belgium",
  },
];

type NewsDataArticle = {
  article_id?: string;
  title?: string;
  link?: string;
  pubDate?: string;
  source_id?: string;
  source_name?: string;
  language?: string;
  description?: string;
  country?: string[];
  category?: string[];
  keywords?: string[];
};

type NewsDataResponse = {
  status?: string;
  results?: NewsDataArticle[];
  message?: string;
};

function parsePublishedDate(value?: string): string {
  if (!value) {
    return new Date().toISOString();
  }

  const parsedDate = new Date(value);

  return Number.isNaN(parsedDate.getTime())
    ? new Date().toISOString()
    : parsedDate.toISOString();
}

function isValidArticle(
  article: NewsDataArticle,
): article is NewsDataArticle & {
  title: string;
  link: string;
} {
  return (
    typeof article.title === "string" &&
    article.title.trim().length > 0 &&
    typeof article.link === "string" &&
    article.link.trim().length > 0
  );
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);

    url.hash = "";

    const removableParameters = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
    ];

    for (const parameter of removableParameters) {
      url.searchParams.delete(parameter);
    }

    return url.toString();
  } catch {
    return value.trim();
  }
}

async function fetchCountryNews(
  apiKey: string,
  targetCountry: TargetCountry,
): Promise<GlobalNewsItem[]> {
  const params = new URLSearchParams({
    apikey: apiKey,
    country: targetCountry.code,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(
      `${NEWSDATA_ENDPOINT}?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        cache: "no-store",
        signal: controller.signal,
      },
    );

    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `NewsData request for ${targetCountry.name} failed with HTTP ${response.status}: ${responseText}`,
      );
    }

    let payload: NewsDataResponse;

    try {
      payload = JSON.parse(responseText) as NewsDataResponse;
    } catch {
      throw new Error(
        `NewsData returned invalid JSON for ${targetCountry.name}.`,
      );
    }

    if (payload.status !== "success") {
      throw new Error(
        payload.message ??
          `NewsData returned an unsuccessful response for ${targetCountry.name}.`,
      );
    }

    const articles = Array.isArray(payload.results)
      ? payload.results
      : [];

    return articles
      .filter(isValidArticle)
      .map((article) => {
        const normalizedUrl = normalizeUrl(article.link);

        return {
          id:
            article.article_id ??
            `${targetCountry.code}:${normalizedUrl}`,
          title: article.title.trim(),
          url: normalizedUrl,
          publishedAt: parsePublishedDate(article.pubDate),
          source:
            article.source_name ??
            article.source_id ??
            "unknown",
          language: article.language,
          summary: article.description,
          raw: {
            ...article,

            worldSignal: {
              targetCountryCode: targetCountry.code.toUpperCase(),
              targetCountryName: targetCountry.name,
              collector: "newsdata-country",
              collectedAt: new Date().toISOString(),
            },
          },
        };
      });
  } finally {
    clearTimeout(timeout);
  }
}

export class GdeltNewsProvider implements GlobalNewsProvider {
  readonly name = "newsdata-syria-belgium";

  async fetchLatest(): Promise<GlobalNewsItem[]> {
    const apiKey = process.env.NEWSDATA_API_KEY;

    if (!apiKey) {
      throw new Error(
        "NEWSDATA_API_KEY is missing from environment variables.",
      );
    }

    const results = await Promise.allSettled(
      TARGET_COUNTRIES.map((country) =>
        fetchCountryNews(apiKey, country),
      ),
    );

    const successfulItems: GlobalNewsItem[] = [];
    const errors: string[] = [];

    results.forEach((result, index) => {
      const country = TARGET_COUNTRIES[index];

      if (result.status === "fulfilled") {
        successfulItems.push(...result.value);
        return;
      }

      errors.push(
        `${country.name}: ${
          result.reason instanceof Error
            ? result.reason.message
            : "Unknown collection error"
        }`,
      );
    });

    if (successfulItems.length === 0 && errors.length > 0) {
      throw new Error(
        `All country collections failed. ${errors.join(" | ")}`,
      );
    }

    const uniqueItems = new Map<string, GlobalNewsItem>();

    for (const item of successfulItems) {
      const duplicateKey = normalizeUrl(item.url).toLowerCase();

      if (!uniqueItems.has(duplicateKey)) {
        uniqueItems.set(duplicateKey, item);
      }
    }

    if (errors.length > 0) {
      console.error(
        "One or more country collections failed:",
        errors,
      );
    }

    return Array.from(uniqueItems.values());
  }
}