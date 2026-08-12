export type ResearchBoundaryErrorCode = "InvalidPublicUrl" | "PublicUrlProtocolRejected" | "PublicUrlCredentialsRejected" | "PublicUrlDestinationRejected" | "InvalidPublicUrlResponseLimit" | "PublicUrlResponseTooLarge";
export declare class ResearchBoundaryError extends Error {
    readonly code: ResearchBoundaryErrorCode;
    constructor(code: ResearchBoundaryErrorCode, options?: ErrorOptions);
}
/**
 * Validate a URL before a public fetch. Hostnames still require DNS pinning or
 * validation after resolution; this function cannot prevent DNS rebinding.
 */
export declare function assertPublicHttpsUrl(value: string | URL): URL;
/** Read a response body while enforcing a byte limit on declared and streamed data. */
export declare function readBoundedText(response: Response, maxBytes: number): Promise<string>;
