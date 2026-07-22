import type {
  GlobalNewsItem,
  GlobalNewsProvider,
} from "./provider";

const NEWSDATA_ENDPOINT = "https://newsdata.io/api/1/latest";

type NewsDataArticle = {
  article_id?: string;
  title?: string;
  link?: string;
  pubDate?: string;
  source_id?: string;
  source_name?: string;
  language?: string;
  description?: string;
};

type NewsDataResponse = {
  status?: string;
  results?: NewsDataArticle[];
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

export class GdeltNewsProvider implements GlobalNewsProvider {
  readonly name = "newsdata";

  async fetchLatest(): Promise<GlobalNewsItem[]> {
    const apiKey = process.env.NEWSDATA_API_KEY;

    if (!apiKey) {
      throw new Error(
        "NEWSDATA_API_KEY is missing from .env.local",
      );
    }

    const params = new URLSearchParams({
      apikey: apiKey,
      language: "en",
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

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

      if (!response.ok) {
        const errorBody = await response.text();

        throw new Error(
          `NewsData request failed with HTTP ${response.status}: ${errorBody}`,
        );
      }

      const payload =
        (await response.json()) as NewsDataResponse;

      if (payload.status !== "success") {
        throw new Error(
          "NewsData returned an unsuccessful response.",
        );
      }

      const articles = Array.isArray(payload.results)
        ? payload.results
        : [];

      return articles
        .filter(
          (article): article is NewsDataArticle & {
            title: string;
            link: string;
          } =>
            typeof article.title === "string" &&
            article.title.trim().length > 0 &&
            typeof article.link === "string" &&
            article.link.length > 0,
        )
        .map((article) => ({
          id: article.article_id ?? article.link,
          title: article.title.trim(),
          url: article.link,
          publishedAt: parsePublishedDate(article.pubDate),
          source:
            article.source_name ??
            article.source_id ??
            "unknown",
          language: article.language,
          summary: article.description,
          raw: article,
        }));
    } finally {
      clearTimeout(timeout);
    }
  }
}