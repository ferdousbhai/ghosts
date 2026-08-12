import ipaddr from "ipaddr.js";
const FORBIDDEN_PUBLIC_HOSTS = new Set([
    "home.arpa",
    "internal",
    "invalid",
    "local",
    "localhost",
    "metadata.google.internal",
    "test",
]);
export class ResearchBoundaryError extends Error {
    code;
    constructor(code, options) {
        super(code, options);
        this.code = code;
        this.name = "ResearchBoundaryError";
    }
}
/**
 * Validate a URL before a public fetch. Hostnames still require DNS pinning or
 * validation after resolution; this function cannot prevent DNS rebinding.
 */
export function assertPublicHttpsUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch (cause) {
        throw new ResearchBoundaryError("InvalidPublicUrl", { cause });
    }
    if (url.protocol !== "https:") {
        throw new ResearchBoundaryError("PublicUrlProtocolRejected");
    }
    if (url.username || url.password) {
        throw new ResearchBoundaryError("PublicUrlCredentialsRejected");
    }
    url.hash = "";
    const hostname = url.hostname
        .toLowerCase()
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "");
    if (FORBIDDEN_PUBLIC_HOSTS.has(hostname) ||
        [...FORBIDDEN_PUBLIC_HOSTS].some((host) => hostname.endsWith(`.${host}`)) ||
        (ipaddr.isValid(hostname) && !isPublicIpAddress(hostname))) {
        throw new ResearchBoundaryError("PublicUrlDestinationRejected");
    }
    return url;
}
/** Read a response body while enforcing a byte limit on declared and streamed data. */
export async function readBoundedText(response, maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new ResearchBoundaryError("InvalidPublicUrlResponseLimit");
    }
    const declared = response.headers.get("Content-Length");
    if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
        await response.body?.cancel().catch(() => { });
        throw new ResearchBoundaryError("PublicUrlResponseTooLarge");
    }
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let result = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel().catch(() => { });
                throw new ResearchBoundaryError("PublicUrlResponseTooLarge");
            }
            result += decoder.decode(value, { stream: true });
        }
        return result + decoder.decode();
    }
    finally {
        reader.releaseLock();
    }
}
function isPublicIpAddress(address) {
    try {
        const parsed = ipaddr.parse(address.replace(/^\[|\]$/g, ""));
        const normalized = parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
            ? parsed.toIPv4Address()
            : parsed;
        return normalized.range() === "unicast";
    }
    catch {
        return false;
    }
}
