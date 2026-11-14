import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SsrfValidationResult {
  safe: boolean;
  reason?: string;
  resolvedIp?: string;
}

/**
 * Checks whether an IPv4 address belongs to a private, loopback, link-local,
 * or cloud metadata IP range.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IPv4 is treated as unsafe
  }

  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;

  // 10.0.0.0/8 (Private network)
  if (a === 10) return true;

  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;

  // 100.64.0.0/10 (Shared address space / Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 169.254.0.0/16 (Link-local / Cloud metadata service e.g. 169.254.169.254)
  if (a === 169 && b === 254) return true;

  // 172.16.0.0/12 (Private network)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0) return true;

  // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 0 && parts[2] === 2) return true;

  // 192.168.0.0/16 (Private network)
  if (a === 192 && b === 168) return true;

  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && b === 51 && parts[2] === 100) return true;

  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && parts[2] === 113) return true;

  // 224.0.0.0/4 (Multicast)
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 (Reserved)
  if (a >= 240) return true;

  // 255.255.255.255 (Broadcast)
  if (ip === "255.255.255.255") return true;

  return false;
}

/**
 * Checks whether an IPv6 address belongs to a loopback, link-local,
 * unique local, or IPv4-mapped private range.
 */
export function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();

  // ::1 (Loopback)
  if (norm === "::1" || norm === "0:0:0:0:0:0:0:1") return true;

  // :: (Unspecified)
  if (norm === "::" || norm === "0:0:0:0:0:0:0:0") return true;

  // fe80::/10 (Link-local)
  if (norm.startsWith("fe8") || norm.startsWith("fe9") || norm.startsWith("fea") || norm.startsWith("feb")) {
    return true;
  }

  // fc00::/7 (Unique local address)
  if (norm.startsWith("fc") || norm.startsWith("fd")) return true;

  // IPv4-mapped IPv6 (::ffff:192.0.2.1)
  if (norm.includes("::ffff:")) {
    const ipv4Part = norm.split("::ffff:")[1];
    if (ipv4Part && isIP(ipv4Part) === 4) {
      return isPrivateIPv4(ipv4Part);
    }
  }

  return false;
}

const FORBIDDEN_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "instance-data",
]);

/**
 * Validates a target URL against SSRF attacks:
 * - Rejects non-HTTP(S) protocols.
 * - Rejects non-standard ports (allowed: 80, 443, or unspecified).
 * - Rejects known forbidden hostnames and loopback patterns.
 * - Resolves all DNS A and AAAA records and ensures none point to private/cloud-metadata IP ranges.
 */
export async function validateUrlForSsrf(targetUrl: string): Promise<SsrfValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { safe: false, reason: "Malformed URL format." };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      safe: false,
      reason: `Disallowed protocol "${parsed.protocol}". Only http:// and https:// are permitted.`,
    };
  }

  // Disallow non-standard ports
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") {
    return {
      safe: false,
      reason: `Disallowed port "${parsed.port}". Only standard web ports (80, 443) are allowed.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Check forbidden hostnames
  if (FORBIDDEN_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    return { safe: false, reason: `Disallowed internal/loopback hostname: ${hostname}` };
  }

  // If hostname is directly an IP literal
  const ipType = isIP(hostname);
  if (ipType === 4) {
    if (isPrivateIPv4(hostname)) {
      return { safe: false, reason: `Target IP ${hostname} is in a private/restricted IPv4 range.` };
    }
    return { safe: true, resolvedIp: hostname };
  }
  if (ipType === 6) {
    if (isPrivateIPv6(hostname)) {
      return { safe: false, reason: `Target IP ${hostname} is in a private/restricted IPv6 range.` };
    }
    return { safe: true, resolvedIp: hostname };
  }

  // Resolve DNS to verify all destination IPs
  try {
    const addresses = await lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return { safe: false, reason: `Could not resolve hostname "${hostname}".` };
    }

    for (const record of addresses) {
      if (record.family === 4 && isPrivateIPv4(record.address)) {
        return {
          safe: false,
          reason: `DNS resolved "${hostname}" to private/internal IPv4 address ${record.address}.`,
        };
      }
      if (record.family === 6 && isPrivateIPv6(record.address)) {
        return {
          safe: false,
          reason: `DNS resolved "${hostname}" to private/internal IPv6 address ${record.address}.`,
        };
      }
    }

    return { safe: true, resolvedIp: addresses[0]?.address };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { safe: false, reason: `DNS lookup failed for "${hostname}": ${msg}` };
  }
}

