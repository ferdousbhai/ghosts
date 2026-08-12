import { z } from "zod";
import type { RedditSearchInput } from "./contracts.js";

export const redditPostSchema = z
  .object({
    author: z.string().nullable(),
    created_utc: z.number().nonnegative().max(8_640_000_000),
    id: z.string().min(1),
    num_comments: z.number().int().nonnegative(),
    permalink: z.string().min(1).max(4_096).regex(/^\/r\/[A-Za-z0-9_]+\/comments\//),
    score: z.number().int(),
    selftext: z.string().max(100_000),
    subreddit: z.string().min(1).max(100),
    title: z.string().min(1).max(1_000),
  })
  .passthrough();

export const redditListingSchema = z
  .object({
    data: z.object({
      children: z
        .array(
          z.object({
            data: redditPostSchema,
          }),
        )
        .max(100),
    }),
  })
  .passthrough();

export type RedditPost = z.infer<typeof redditPostSchema>;

export type RedditSearchResult = Readonly<{
  author: string | null;
  comments: number;
  date: string;
  excerpt: string;
  score: number;
  subreddit: string;
  title: string;
  url: string;
}>;

export function buildRedditSearchQuery(
  input: Pick<RedditSearchInput, "query" | "subreddits">,
): string {
  return [
    input.query,
    input.subreddits?.length
      ? `(${input.subreddits.map((name) => `subreddit:${name}`).join(" OR ")})`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function buildRedditSearchUrl(
  input: RedditSearchInput,
  endpoint = "https://www.reddit.com/search.json",
): URL {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    q: buildRedditSearchQuery(input),
    sort: input.sort,
    t: input.time_range,
    limit: String(input.num_results),
    raw_json: "1",
  }).toString();
  return url;
}

export function normalizeRedditPost(post: RedditPost): RedditSearchResult {
  return {
    author: post.author,
    comments: post.num_comments,
    date: new Date(post.created_utc * 1_000).toISOString(),
    excerpt: post.selftext.replace(/\s+/g, " ").trim().slice(0, 1_500),
    score: post.score,
    subreddit: post.subreddit,
    title: post.title,
    url: new URL(post.permalink, "https://www.reddit.com").toString(),
  };
}

export function parseRedditSearchResults(
  untrusted: unknown,
  limit: number,
): RedditSearchResult[] {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("Reddit result limit must be a non-negative safe integer");
  }
  const listing = redditListingSchema.parse(untrusted);
  return listing.data.children
    .slice(0, limit)
    .map(({ data }) => normalizeRedditPost(data));
}
