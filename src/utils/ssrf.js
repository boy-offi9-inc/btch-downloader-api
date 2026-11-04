const net = require("node:net");
const dns = require("node:dns");

/**
 * SSRF guard for /api/fetch-media.
 *
 * Two layers work together:
 *  1. assertPublicHostname()  — rejects obviously internal hostnames and IP
 *     literals up front (an IP literal never triggers a DNS lookup, so it
 *     can only be checked here).
 *  2. guardedLookup()         — handed to http(s).request as its `lookup`
 *     option, so the address that is actually connected to is the one that
 *     gets checked. That closes the DNS-rebinding gap that a "resolve, check,
 *     then fetch again" approach leaves open.
 *
 * Every redirect hop goes through both layers again (see fetchMedia).
 */

const ApiError = require("./ApiError");

const BLOCKED_NAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function ipv4ToParts(ip) {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

function isPrivateIPv4(ip) {
  const p = ipv4ToParts(ip);
  if (!p) return true; // malformed -> refuse
  const [a, b, c] = p;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata lives here)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // private
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Expands any valid IPv6 string (incl. "::" and a dotted-quad tail) to 8 numeric groups. */
function expandIPv6(ip) {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);

  // Dotted-quad tail (::ffff:1.2.3.4) -> two hex groups.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToParts(tail);
    if (!v4) return null;
    s = s.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
}

function embeddedIPv4(g, i) {
  return `${g[i] >> 8}.${g[i] & 255}.${g[i + 1] >> 8}.${g[i + 1] & 255}`;
}

function isPrivateIPv6(ip) {
  const g = expandIPv6(ip);
  if (!g) return true; // malformed -> refuse

  const first96Zero = g.slice(0, 6).every((n) => n === 0);
  if (first96Zero) {
    // ::, ::1, and the deprecated IPv4-compatible form ::a.b.c.d
    if (g[6] === 0 && g[7] <= 1) return true;
    return isPrivateIPv4(embeddedIPv4(g, 6));
  }
  // ::ffff:a.b.c.d (IPv4-mapped) — judge by the IPv4 address inside.
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return isPrivateIPv4(embeddedIPv4(g, 6));
  // 64:ff9b::/96 (NAT64) — judge by the embedded IPv4.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return isPrivateIPv4(embeddedIPv4(g, 6));
  // 2002::/16 (6to4) — judge by the embedded IPv4.
  if (g[0] === 0x2002) return isPrivateIPv4(embeddedIPv4(g, 1));

  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** True when `ip` (v4 or v6, optionally bracketed) is not a public, routable address. */
function isPrivateAddress(ip) {
  const clean = String(ip || "").replace(/^\[|\]$/g, "");
  const family = net.isIP(clean.split("%")[0]);
  if (family === 4) return isPrivateIPv4(clean);
  if (family === 6) return isPrivateIPv6(clean);
  return true; // not an IP at all -> never treat as public
}

function stripHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** Optional allowlist (FETCH_MEDIA_ALLOWED_HOSTS). Entries match the host itself or any subdomain. */
function parseAllowedHosts(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^\*?\./, ""))
    .filter(Boolean);
}

function isHostAllowed(hostname, allowed) {
  if (!allowed || !allowed.length) return true;
  const h = stripHost(hostname);
  return allowed.some((a) => h === a || h.endsWith("." + a));
}

/**
 * Synchronous checks that need no DNS: internal-looking names, IP literals,
 * and the optional host allowlist. Throws ApiError(400) on a refusal.
 */
function assertPublicHostname(hostname, { allowedHosts } = {}) {
  const h = stripHost(hostname);
  if (!h) throw new ApiError(400, "Refusing to fetch an empty host.");
  if (h === "localhost" || BLOCKED_NAME_SUFFIXES.some((s) => h.endsWith(s))) {
    throw new ApiError(400, "Refusing to fetch a private/internal address.");
  }
  if (net.isIP(h) && isPrivateAddress(h)) {
    throw new ApiError(400, "Refusing to fetch a private/internal address.");
  }
  if (!isHostAllowed(h, allowedHosts)) {
    throw new ApiError(400, "That media host is not on this server's allowlist.");
  }
}

/**
 * `lookup` function for http(s).request. Resolves every address for the host
 * and refuses the connection if ANY of them is private — so a name that
 * answers with one public and one internal record can't be used to slip in.
 */
function createGuardedLookup(lookup = dns.lookup) {
  return function guardedLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }];
      const bad = list.find((a) => isPrivateAddress(a.address));
      if (bad || !list.length) {
        const e = new Error("Blocked private/internal address");
        e.code = "EBLOCKED_ADDRESS";
        return callback(e);
      }
      if (options && options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

module.exports = {
  isPrivateAddress,
  assertPublicHostname,
  createGuardedLookup,
  parseAllowedHosts,
  isHostAllowed,
};
