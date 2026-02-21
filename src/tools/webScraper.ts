import axios from "axios";
import * as cheerio from "cheerio";

export interface WebPage {
  url: string;
  title: string;
  content: string;
  fetchedAt: string;
}

/**
 * Fetches a web page and extracts its readable text content.
 */
export async function fetchWebPage(url: string): Promise<WebPage> {
  const response = await axios.get(url, {
    headers: {
      "User-Agent": "LuAI Legal Assistant / 0.1.0",
    },
    timeout: 30_000,
  });

  const $ = cheerio.load(response.data as string);

  // Remove non-content elements
  $("script, style, nav, footer, header, aside, iframe, noscript").remove();

  const title = $("title").text().trim();
  const content = $("body").text().replace(/\s+/g, " ").trim();

  return {
    url,
    title,
    content,
    fetchedAt: new Date().toISOString(),
  };
}
