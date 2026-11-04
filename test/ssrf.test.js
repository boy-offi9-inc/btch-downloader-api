const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isPrivateAddress,
  assertPublicHostname,
  createGuardedLookup,
  parseAllowedHosts,
  isHostAllowed,
} = require("../src/utils/ssrf");

test("isPrivateAddress: blocks private, loopback, link-local and reserved IPv4", () => {
  for (const ip of [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test("isPrivateAddress: allows ordinary public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "93.184.216.34"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("isPrivateAddress: blocks private IPv6, including IPv4-mapped forms", () => {
  for (const ip of [
    "::", "::1", "[::1]", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "64:ff9b::7f00:1", "2002:7f00:1::1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
});

test("isPrivateAddress: allows public IPv6 and public IPv4-mapped addresses", () => {
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("isPrivateAddress: anything that is not an IP is never treated as public", () => {
  assert.equal(isPrivateAddress("example.com"), true);
  assert.equal(isPrivateAddress(""), true);
});

test("assertPublicHostname: refuses localhost-style names and private IP literals", () => {
  for (const host of ["localhost", "LOCALHOST.", "foo.localhost", "printer.local", "db.internal", "127.0.0.1", "[::1]", "10.1.2.3", "169.254.169.254"]) {
    assert.throws(() => assertPublicHostname(host), (e) => e.statusCode === 400, host);
  }
});

test("assertPublicHostname: accepts normal public hosts", () => {
  assert.doesNotThrow(() => assertPublicHostname("cdn.example.com"));
  assert.doesNotThrow(() => assertPublicHostname("8.8.8.8"));
});

test("allowlist: host itself and subdomains match; lookalikes do not", () => {
  const allowed = parseAllowedHosts(" googlevideo.com, *.tiktokcdn.com ,");
  assert.deepEqual(allowed, ["googlevideo.com", "tiktokcdn.com"]);
  assert.equal(isHostAllowed("rr1.googlevideo.com", allowed), true);
  assert.equal(isHostAllowed("googlevideo.com", allowed), true);
  assert.equal(isHostAllowed("evilgooglevideo.com", allowed), false);
  assert.equal(isHostAllowed("googlevideo.com.evil.io", allowed), false);
  assert.equal(isHostAllowed("anything.com", []), true, "empty allowlist = allow all public hosts");
  assert.throws(() => assertPublicHostname("other.com", { allowedHosts: allowed }), (e) => e.statusCode === 400);
});

function callLookup(lookup, options = {}) {
  return new Promise((resolve) => createGuardedLookup(lookup)("x.example", options, (err, a, f) => resolve({ err, a, f })));
}

test("guardedLookup: refuses when ANY resolved address is private (mixed records)", async () => {
  const fake = (_h, _o, cb) => cb(null, [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.5", family: 4 }]);
  const { err } = await callLookup(fake);
  assert.equal(err && err.code, "EBLOCKED_ADDRESS");
});

test("guardedLookup: passes public answers through in both callback shapes", async () => {
  const fake = (_h, _o, cb) => cb(null, [{ address: "8.8.8.8", family: 4 }]);
  const single = await callLookup(fake, {});
  assert.deepEqual([single.err, single.a, single.f], [null, "8.8.8.8", 4]);
  const all = await callLookup(fake, { all: true });
  assert.deepEqual(all.a, [{ address: "8.8.8.8", family: 4 }]);
});

test("guardedLookup: DNS errors are passed through untouched", async () => {
  const boom = Object.assign(new Error("nx"), { code: "ENOTFOUND" });
  const { err } = await callLookup((_h, _o, cb) => cb(boom));
  assert.equal(err, boom);
});

test("guardedLookup: the real resolver blocks 'localhost' (rebinding-style check)", async () => {
  const { err } = await new Promise((resolve) =>
    createGuardedLookup()("localhost", {}, (e, a, f) => resolve({ err: e, a, f }))
  );
  assert.equal(err && err.code, "EBLOCKED_ADDRESS");
});
