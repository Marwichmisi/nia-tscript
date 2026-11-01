// S1/S2 — forwarding pur : version, headers, SSE, erreurs (ticket #11).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  protocolVersionForMessage,
  buildForwardHeaders,
  extractResponseLines,
  appClosedError,
  isNotification,
} from "../lib.mjs";

describe("S1 — version du header", () => {
  it("priorité _meta moderne, sinon params.initialize, sinon lockfile", () => {
    const modern = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    };
    assert.equal(protocolVersionForMessage(modern, "2026-07-28"), "2026-07-28");
    const legacy = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    };
    assert.equal(protocolVersionForMessage(legacy, "2026-07-28"), "2025-06-18");
    const nue = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
    assert.equal(protocolVersionForMessage(nue, "2026-07-28"), "2026-07-28");
  });
});

describe("S1 — headers forward", () => {
  it("requête moderne (_meta) : content-type/accept/mcp-*/authorization, Mcp-Name si name/uri", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "pcb_state",
        arguments: {},
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    };
    const h = buildForwardHeaders(msg, { url: "http://127.0.0.1:1/mcp", token: "tok", protocolVersion: "2026-07-28" });
    assert.equal(h["content-type"], "application/json");
    assert.match(h.accept, /text\/event-stream/);
    assert.equal(h["mcp-protocol-version"], "2026-07-28");
    assert.equal(h["mcp-method"], "tools/call");
    assert.equal(h["mcp-name"], "pcb_state");
    assert.equal(h.authorization, "Bearer tok");
  });

  it("resources/read moderne mappe params.uri vers Mcp-Name, absent sinon", () => {
    const res = {
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: {
        uri: "pcb://hierarchy",
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    };
    const h = buildForwardHeaders(res, { url: "u", token: "t", protocolVersion: "V" });
    assert.equal(h["mcp-name"], "pcb://hierarchy");
    const list = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    };
    assert.ok(!("mcp-name" in buildForwardHeaders(list, { url: "u", token: "t", protocolVersion: "V" })));
  });

  it("requête stdio sans _meta : aucun header mcp-* (le serveur sert en legacy)", () => {
    const msg = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "pcb_state" } };
    const h = buildForwardHeaders(msg, { url: "u", token: "t", protocolVersion: "2026-07-28" });
    assert.equal(h.authorization, "Bearer t");
    assert.equal(h["content-type"], "application/json");
    assert.ok(!("mcp-protocol-version" in h));
    assert.ok(!("mcp-method" in h));
    assert.ok(!("mcp-name" in h));
  });

  it("initialize legacy (2025-*) : version + method, sans Mcp-Name", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    };
    const h = buildForwardHeaders(msg, { url: "u", token: "t", protocolVersion: "2026-07-28" });
    assert.equal(h["mcp-protocol-version"], "2025-06-18");
    assert.equal(h["mcp-method"], "initialize");
    assert.ok(!("mcp-name" in h));
  });

  it("initialize moderne (2026-*) sans _meta : aucun header mcp-* (le serveur négocie en legacy)", () => {
    const msg = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "opencode", version: "x" } },
    };
    const h = buildForwardHeaders(msg, { url: "u", token: "t", protocolVersion: "2026-07-28" });
    assert.equal(h.authorization, "Bearer t");
    assert.ok(!("mcp-protocol-version" in h), "pas de header moderne sans enveloppe moderne");
    assert.ok(!("mcp-method" in h));
  });
});

describe("S1 — réponses JSON et SSE", () => {
  it("JSON direct : une ligne trimmée", () => {
    const lines = extractResponseLines("application/json", '  {"jsonrpc":"2.0","id":1}  \n');
    assert.deepEqual(lines, ['{"jsonrpc":"2.0","id":1}']);
  });

  it("SSE : extrait chaque data:, ignore commentaires et [DONE]", () => {
    const sse = [
      ": ping",
      'data: {"jsonrpc":"2.0","id":1,"result":{}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    assert.deepEqual(extractResponseLines("text/event-stream", sse), [
      '{"jsonrpc":"2.0","id":1,"result":{}}',
    ]);
  });

  it("body vide : aucune ligne (cas 202 notification)", () => {
    assert.deepEqual(extractResponseLines("application/json", "   \n"), []);
  });
});

describe("S2 — app fermée et notifications", () => {
  it("erreur -32000 « ouvre l'app », id préservé", () => {
    const line = appClosedError(42, "http://127.0.0.1:9/mcp");
    const parsed = JSON.parse(line);
    assert.equal(parsed.jsonrpc, "2.0");
    assert.equal(parsed.id, 42);
    assert.equal(parsed.error.code, -32000);
    assert.match(parsed.error.message, /ouvre l'app/);
  });

  it("notification (sans id) : jamais de réponse", () => {
    assert.equal(isNotification({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }), true);
    assert.equal(isNotification({ jsonrpc: "2.0", id: 1, method: "tools/list" }), false);
    assert.equal(isNotification({ jsonrpc: "2.0", id: 0, method: "tools/list" }), false);
  });
});
