import { z } from "zod";
import type { RedditSearchInput } from "./contracts.js";
export declare const redditPostSchema: z.ZodObject<{
    author: z.ZodNullable<z.ZodString>;
    created_utc: z.ZodNumber;
    id: z.ZodString;
    num_comments: z.ZodNumber;
    permalink: z.ZodString;
    score: z.ZodNumber;
    selftext: z.ZodString;
    subreddit: z.ZodString;
    title: z.ZodString;
}, z.core.$loose>;
export declare const redditListingSchema: z.ZodObject<{
    data: z.ZodObject<{
        children: z.ZodArray<z.ZodObject<{
            data: z.ZodObject<{
                author: z.ZodNullable<z.ZodString>;
                created_utc: z.ZodNumber;
                id: z.ZodString;
                num_comments: z.ZodNumber;
                permalink: z.ZodString;
                score: z.ZodNumber;
                selftext: z.ZodString;
                subreddit: z.ZodString;
                title: z.ZodString;
            }, z.core.$loose>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$loose>;
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
export declare function buildRedditSearchQuery(input: Pick<RedditSearchInput, "query" | "subreddits">): string;
export declare function buildRedditSearchUrl(input: RedditSearchInput, endpoint?: string): URL;
export declare function normalizeRedditPost(post: RedditPost): RedditSearchResult;
export declare function parseRedditSearchResults(untrusted: unknown, limit: number): RedditSearchResult[];
