// S5 — lockfile multi-OS + lecture validée (ticket #11).
// Rouge d'abord : lib.mjs n'existe pas encore.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultLockfilePath,
  readLockfileSync,
} from "../lib.mjs";

describe("S5 — chemin lockfile multi-OS", () => {
  it("Linux : $XDG_CACHE_HOME sinon ~/.cache", () => {
    const p1 = defaultLockfilePath({
      platform: "linux",
      env: { XDG_CACHE_HOME: "/tmp/xdg" },
      homedir: "/home/u",
    });
    assert.equal(p1, path.join("/tmp/xdg", "niatscircuit", "mcp.json"));
    const p2 = defaultLockfilePath({
      platform: "linux",
      env: {},
      homedir: "/home/u",
    });
    assert.equal(p2, path.join("/home/u", ".cache", "niatscircuit", "mcp.json"));
  });

  it("macOS : ~/Library/Caches", () => {
    const p = defaultLockfilePath({ platform: "darwin", env: {}, homedir: "/Users/u" });
    assert.equal(p, path.join("/Users/u", "Library", "Caches", "niatscircuit", "mcp.json"));
  });

  it("Windows : %LOCALAPPDATA% sinon %USERPROFILE%\\AppData\\Local", () => {
    const p1 = defaultLockfilePath({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      homedir: "C:\\Users\\u",
    });
    assert.equal(p1, path.join("C:\\Users\\u\\AppData\\Local", "niatscircuit", "mcp.json"));
    const p2 = defaultLockfilePath({
      platform: "win32",
      env: {},
      homedir: "C:\\Users\\u",
    });
    assert.ok(p2.endsWith(path.join("niatscircuit", "mcp.json")));
  });

  it("override env NIATSCIRCUIT_MCP_LOCK prioritaire", () => {
    const p = defaultLockfilePath({
      platform: "linux",
      env: { NIATSCIRCUIT_MCP_LOCK: "/tmp/custom/mcp.json" },
      homedir: "/home/u",
    });
    assert.equal(p, "/tmp/custom/mcp.json");
  });
});

describe("S5 — lecture lockfile validée", () => {
  it("lit url + token + protocolVersion", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-lock-"));
    const fp = path.join(dir, "mcp.json");
    fs.writeFileSync(
      fp,
      JSON.stringify({
        port: 4123,
        token: "tok-abc",
        pid: 123,
        startedAt: "2026-11-01T00:00:00Z",
        url: "http://127.0.0.1:4123/mcp",
        protocolVersion: "2026-07-28",
      }),
    );
    const lock = readLockfileSync(fp);
    assert.equal(lock.url, "http://127.0.0.1:4123/mcp");
    assert.equal(lock.token, "tok-abc");
    assert.equal(lock.protocolVersion, "2026-07-28");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejette JSON invalide, url non-locale, token vide", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nia-lock-"));
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{ pas du json");
    assert.throws(() => readLockfileSync(bad));
    const nonLocal = path.join(dir, "nonlocal.json");
    fs.writeFileSync(nonLocal, JSON.stringify({ url: "http://evil.test/mcp", token: "x" }));
    assert.throws(() => readLockfileSync(nonLocal));
    const emptyTok = path.join(dir, "empty.json");
    fs.writeFileSync(emptyTok, JSON.stringify({ url: "http://127.0.0.1:1/mcp", token: "" }));
    assert.throws(() => readLockfileSync(emptyTok));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
