// snail — platform Worker
// Serves the platform pages (static assets) and one MCP per knowledge
// space at /<space>/mcp. KB-first: each space's knowledge lives in
// markdown docs under spaces/<space>/ in R2. The server is a thin,
// generic layer — kb_topics / kb_search / kb_get — with no facts or
// per-space logic in code. It stores nothing. No KV, by design.

const MCP_SERVER = { name: "snail-kb", version: "0.1.0" };
const KB_CACHE_MS = 5 * 60 * 1000;
const kbCaches = new Map(); // space -> { at, docs }
const mcpHits = new Map(); // space|ip -> [timestamps] (best-effort, per isolate)

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const KB_TOOLS = [
  {
    name: "kb_topics",
    description:
      "List this space's knowledge base: every document's id, title, topics, type, and section headings. Call this first to see what the KB holds.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "kb_search",
    description:
      "Search this space's knowledge base. Returns the best-matching passages exactly as written, each with its document id and section heading. Answer only from returned passages; if nothing matches, say the KB does not cover it.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in plain words." },
        topics: {
          type: "array",
          items: { type: "string" },
          description: "Optional topic filter, e.g. [\"cases\"], [\"playbooks\"].",
        },
        limit: { type: "integer", description: "Max passages to return (default 5).", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "kb_get",
    description:
      "Get a full knowledge-base document by id, or one section of it by heading. Use after kb_topics or kb_search when you need the complete text.",
    inputSchema: {
      type: "object",
      properties: {
        doc_id: { type: "string", description: "Document id from kb_topics / kb_search, e.g. \"cases\"." },
        section: { type: "string", description: "Optional section heading (partial match is fine)." },
      },
      required: ["doc_id"],
      additionalProperties: false,
    },
  },
];

function parseFrontMatter(raw) {
  const meta = {};
  let body = raw;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (m) {
    body = raw.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      let v = kv[2].trim();
      if (v.startsWith("[") && v.endsWith("]")) {
        v = v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
      } else if (v === "true") v = true;
      else if (v === "false") v = false;
      meta[kv[1]] = v;
    }
  }
  return { meta, body };
}

function splitSections(body, docTitle) {
  const sections = [];
  const parts = body.split(/^## /m);
  const intro = (parts[0] || "").trim();
  if (intro) sections.push({ heading: docTitle, text: intro });
  for (let i = 1; i < parts.length; i++) {
    const nl = parts[i].indexOf("\n");
    const heading = (nl < 0 ? parts[i] : parts[i].slice(0, nl)).trim();
    const text = ("## " + parts[i]).trim();
    if (heading && text) sections.push({ heading, text });
  }
  return sections;
}

async function loadKb(env, space) {
  const prefix = `spaces/${space}/`;
  const cached = kbCaches.get(space);
  if (cached && cached.docs && Date.now() - cached.at < KB_CACHE_MS) return cached.docs;
  const listed = await env.KB.list({ prefix });
  const docs = [];
  for (const o of listed.objects || []) {
    if (!o.key.endsWith(".md")) continue;
    const obj = await env.KB.get(o.key);
    if (!obj) continue;
    const { meta, body } = parseFrontMatter(await obj.text());
    const fallbackId = o.key.slice(prefix.length).replace(/\.md$/, "");
    const title = meta.title || fallbackId;
    docs.push({
      id: meta.id || fallbackId,
      title,
      topics: Array.isArray(meta.topics) ? meta.topics : [],
      type: meta.type || "fact",
      verbatim: meta.verbatim === true,
      updated: meta.updated || null,
      sections: splitSections(body, title),
    });
  }
  docs.sort((a, b) => a.id.localeCompare(b.id));
  kbCaches.set(space, { at: Date.now(), docs });
  return docs;
}

function kbTopicsResult(docs) {
  return {
    documents: docs.map((d) => ({
      id: d.id,
      title: d.title,
      topics: d.topics,
      type: d.type,
      verbatim: d.verbatim,
      updated: d.updated,
      sections: d.sections.map((s) => s.heading),
    })),
  };
}

function kbSearchResult(docs, args) {
  const query = String(args.query || "").trim();
  const words = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))];
  const topicFilter = Array.isArray(args.topics)
    ? args.topics.map((t) => String(t).toLowerCase())
    : [];
  const limit = Math.min(10, Math.max(1, parseInt(args.limit, 10) || 5));
  const scored = [];
  for (const d of docs) {
    const topicHit = topicFilter.length
      ? d.topics.some((t) => topicFilter.includes(t.toLowerCase()))
      : false;
    if (topicFilter.length && !topicHit) continue;
    for (const s of d.sections) {
      const head = s.heading.toLowerCase();
      const text = s.text.toLowerCase();
      let score = topicHit ? 2 : 0;
      for (const w of words) {
        if (head.includes(w)) score += 3;
        let idx = 0;
        while ((idx = text.indexOf(w, idx)) >= 0) { score += 1; idx += w.length; }
      }
      if (score > 0) {
        scored.push({
          score,
          doc_id: d.id,
          doc_title: d.title,
          section: s.heading,
          verbatim: d.verbatim,
          text: s.text,
        });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const passages = scored.slice(0, limit).map(({ score, ...rest }) => rest);
  if (!passages.length) {
    return {
      passages: [],
      note: "No matching passage in this space's knowledge base. Call kb_topics to see what the KB covers, and tell the user plainly when the KB does not cover their question.",
    };
  }
  return { passages };
}

function kbGetResult(docs, args) {
  const docId = String(args.doc_id || "").trim().toLowerCase();
  const doc = docs.find((d) => d.id.toLowerCase() === docId);
  if (!doc) {
    return { error: `unknown doc_id: ${args.doc_id}`, known: docs.map((d) => d.id) };
  }
  const base = { doc_id: doc.id, title: doc.title, verbatim: doc.verbatim };
  if (args.section) {
    const want = String(args.section).toLowerCase();
    const sec = doc.sections.find((s) => s.heading.toLowerCase().includes(want));
    if (!sec) {
      return { ...base, error: `no section matching: ${args.section}`, sections: doc.sections.map((s) => s.heading) };
    }
    return { ...base, section: sec.heading, text: sec.text };
  }
  return { ...base, text: doc.sections.map((s) => s.text).join("\n\n") };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function mcpRespond(request, payload, status = 200) {
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/event-stream")) {
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
      status,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }
  return json(payload, status);
}

function mcpRateLimited(request, space) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const key = `${space}|${ip}`;
  const now = Date.now();
  const arr = (mcpHits.get(key) || []).filter((t) => now - t < 60000);
  arr.push(now);
  mcpHits.set(key, arr);
  return arr.length > 240;
}

async function mcp(request, env, space) {
  if (request.method === "GET") {
    return new Response(
      `snail — space "${space}" knowledge base, MCP server (${MCP_SERVER.name} ${MCP_SERVER.version})\n` +
        `POST JSON-RPC to this URL. Tools: kb_topics, kb_search, kb_get.\n` +
        `Answers come only from this space's KB documents. The service stores nothing.\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (mcpRateLimited(request, space)) return json(rpcError(null, -32000, "rate limited — slow down"), 429);

  let msg;
  try {
    msg = await request.json();
  } catch (_) {
    return mcpRespond(request, rpcError(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(msg)) return mcpRespond(request, rpcError(null, -32600, "Batch requests are not supported"), 400);
  const { id, method, params } = msg || {};
  if (typeof method !== "string") return mcpRespond(request, rpcError(id, -32600, "Invalid request"), 400);
  if (method.startsWith("notifications/")) return new Response(null, { status: 202 });

  try {
    switch (method) {
      case "initialize":
        return mcpRespond(request, rpcResult(id, {
          protocolVersion: (params && params.protocolVersion) || "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: MCP_SERVER,
          instructions:
            `Professional knowledge base — space "${space}" on snail. Answer only from KB passages ` +
            `(kb_search / kb_get); quote prices, terms, and credentials exactly as written; never invent ` +
            `a benefit, a case, or an outcome; never claim regulatory approval, certification, or compliance ` +
            `on anyone's behalf; if the KB does not cover a question, say so plainly. The KB stores nothing ` +
            `and the asker stays anonymous. Reply in telegram style: short lines, tables, bullets.`,
        }));
      case "ping":
        return mcpRespond(request, rpcResult(id, {}));
      case "tools/list":
        return mcpRespond(request, rpcResult(id, { tools: KB_TOOLS }));
      case "tools/call": {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        const docs = await loadKb(env, space);
        let out;
        if (name === "kb_topics") out = kbTopicsResult(docs);
        else if (name === "kb_search") {
          if (!args.query) return mcpRespond(request, rpcError(id, -32602, "kb_search requires a query"));
          out = kbSearchResult(docs, args);
        } else if (name === "kb_get") {
          if (!args.doc_id) return mcpRespond(request, rpcError(id, -32602, "kb_get requires a doc_id"));
          out = kbGetResult(docs, args);
        } else {
          return mcpRespond(request, rpcError(id, -32602, `unknown tool: ${name}`));
        }
        const isError = !!out.error;
        return mcpRespond(request, rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          isError,
        }));
      }
      default:
        return mcpRespond(request, rpcError(id, -32601, `method not found: ${method}`));
    }
  } catch (e) {
    return mcpRespond(request, rpcError(id, -32603, String((e && e.message) || e)), 500);
  }
}

const SPACE_MCP = /^\/([a-z0-9][a-z0-9_-]*)\/mcp$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const m = SPACE_MCP.exec(url.pathname);
      if (m) return await mcp(request, env, m[1]);
      return await env.ASSETS.fetch(request);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
