/** 公开 RSS/Atom 采集：按固定窗口分页、逐页保存，限流后退出并按冷却时间续取。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const SOURCES = {
  reddit: "https://www.reddit.com/r/GlobalOffensive/new/.rss",
  hltv: "https://www.hltv.org/rss/news",
};
const ATOM_NS = "http://www.w3.org/2005/Atom";
const MAX_FEED_BYTES = 2_000_000;

export class HttpError extends Error {
  constructor(url, status, retryAfter = null) {
    super(`HTTP ${status}: ${url}`);
    this.name = "HttpError";
    this.url = url;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export class NetworkError extends Error {
  constructor(cause, code = "NetworkError") {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = code;
    this.cause = cause;
  }
}

export class FeedParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedParseError";
  }
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  ndash: "\u2013", mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019",
  ldquo: "\u201c", rdquo: "\u201d", hellip: "\u2026", copy: "\u00a9",
};

function decodeEntities(text) {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([A-Za-z][A-Za-z0-9]+));/g, (match, hex, dec, named) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (dec) {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return Object.hasOwn(NAMED_ENTITIES, named) ? NAMED_ENTITIES[named] : match;
  });
}

export function plain(text) {
  const parts = [];
  let skip = 0;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      if (!skip) {
        const chunk = decodeEntities(text.slice(i));
        if (chunk) parts.push(chunk);
      }
      break;
    }
    if (lt > i && !skip) {
      const chunk = decodeEntities(text.slice(i, lt));
      if (chunk) parts.push(chunk);
    }
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    const gt = text.indexOf(">", lt + 1);
    if (gt === -1) {
      if (!skip) parts.push(decodeEntities(text.slice(lt)));
      break;
    }
    const rawTag = text.slice(lt + 1, gt).trim();
    const closing = rawTag.startsWith("/");
    const selfClosing = !closing && rawTag.endsWith("/");
    const nameMatch = /^\/?\s*([A-Za-z0-9:-]+)/.exec(rawTag);
    const tag = nameMatch ? nameMatch[1].toLowerCase() : "";
    if (tag === "script" || tag === "style") {
      if (closing) skip = Math.max(0, skip - 1);
      else if (!selfClosing) skip += 1;
    }
    i = gt + 1;
  }
  return parts.join(" ");
}

const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
const RFC2822_WITH_TZ = /^(?:[A-Za-z]{3},\s+)?\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}\s+\d{2}:\d{2}(?::\d{2})?\s+(?:GMT|UTC|UT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|[+-]\d{4})$/i;

export function timestamp(value) {
  if (typeof value !== "string") throw new FeedParseError("timestamp_invalid");
  const trimmed = value.trim();
  if (!ISO_WITH_TZ.test(trimmed) && !RFC2822_WITH_TZ.test(trimmed)) {
    throw new FeedParseError("timestamp_timezone_required");
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) throw new FeedParseError("timestamp_invalid");
  return ms / 1000;
}

export function iso(seconds) {
  return new Date(seconds * 1000).toISOString();
}

function parseAttributes(raw) {
  const attrs = {};
  const regex = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

function resolveName(rawName, nsMap) {
  const idx = rawName.indexOf(":");
  if (idx === -1) return { local: rawName, ns: nsMap[""] ?? "" };
  const prefix = rawName.slice(0, idx);
  return { local: rawName.slice(idx + 1), ns: nsMap[prefix] ?? "" };
}

function parseXml(input) {
  const text = input.replace(/^\uFEFF/, "");
  const stack = [];
  let root = null;
  let i = 0;

  const pushText = chunk => {
    if (stack.length && chunk) stack[stack.length - 1].text += chunk;
  };

  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) {
      pushText(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) pushText(decodeEntities(text.slice(i, lt)));
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      if (end === -1) throw new FeedParseError("unclosed_cdata");
      pushText(text.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      if (end === -1) throw new FeedParseError("unclosed_comment");
      i = end + 3;
      continue;
    }
    if (text.startsWith("<?", lt)) {
      const end = text.indexOf("?>", lt + 2);
      if (end === -1) throw new FeedParseError("unclosed_pi");
      i = end + 2;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      const end = text.indexOf(">", lt + 2);
      if (end === -1) throw new FeedParseError("unclosed_decl");
      i = end + 1;
      continue;
    }
    // Find closing '>' outside quoted attribute values.
    let gt = -1;
    let quote = null;
    for (let j = lt + 1; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        gt = j;
        break;
      }
    }
    if (gt === -1) throw new FeedParseError("unclosed_tag");
    const rawTag = text.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (rawTag.startsWith("/")) {
      const closeName = rawTag.slice(1).trim();
      const top = stack.pop();
      if (!top || top.rawName !== closeName) throw new FeedParseError("mismatched_tag");
      continue;
    }
    const selfClosing = rawTag.endsWith("/");
    const body = selfClosing ? rawTag.slice(0, -1).trim() : rawTag;
    const space = body.search(/\s/);
    const rawName = space === -1 ? body : body.slice(0, space);
    if (!rawName || !/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(rawName)) throw new FeedParseError("invalid_tag_name");
    const attrs = space === -1 ? {} : parseAttributes(body.slice(space + 1));
    const parentNs = stack.length ? stack[stack.length - 1].nsMap : {};
    const nsMap = { ...parentNs };
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "xmlns") nsMap[""] = v;
      else if (k.startsWith("xmlns:")) nsMap[k.slice(6)] = v;
    }
    const { local, ns } = resolveName(rawName, nsMap);
    const node = { rawName, local, ns, nsMap, attrs, children: [], text: "" };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else if (!root) root = node;
    else throw new FeedParseError("multiple_roots");
    if (!selfClosing) stack.push(node);
  }
  if (stack.length || !root) throw new FeedParseError("incomplete_xml");
  return root;
}

const findChild = (node, local, ns = "") => node.children.find(child => child.local === local && child.ns === ns);
const findChildren = (node, local, ns = "") => node.children.filter(child => child.local === local && child.ns === ns);
const childText = (node, local, ns = "", fallback = null) => {
  const child = findChild(node, local, ns);
  return child ? child.text : fallback;
};

export function parseFeedXml(raw) {
  const root = parseXml(raw);
  const rows = [];
  if (root.local === "rss" && root.ns === "") {
    for (const channel of findChildren(root, "channel")) {
      for (const entry of findChildren(channel, "item")) {
        rows.push({
          id: childText(entry, "guid") || childText(entry, "link"),
          title: childText(entry, "title"),
          url: childText(entry, "link"),
          published: childText(entry, "pubDate"),
          text: plain(childText(entry, "description", "", "")),
          body_status: "discovery_only",
        });
      }
    }
  } else if (root.local === "feed" && root.ns === ATOM_NS) {
    for (const entry of findChildren(root, "entry", ATOM_NS)) {
      const link = findChildren(entry, "link", ATOM_NS).find(el => (el.attrs.rel ?? "alternate") === "alternate");
      rows.push({
        id: childText(entry, "id", ATOM_NS),
        title: childText(entry, "title", ATOM_NS),
        url: link?.attrs.href ?? null,
        published: childText(entry, "published", ATOM_NS),
        updated: childText(entry, "updated", ATOM_NS),
        text: plain(childText(entry, "content", ATOM_NS, "")),
        body_status: "atom_content_requires_review",
      });
    }
  } else {
    throw new FeedParseError("not_rss_or_atom");
  }
  return rows;
}

async function readBoundedText(response, maxBytes) {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new FeedParseError("feed_too_large");
    return new TextDecoder("utf-8").decode(bytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FeedParseError("feed_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

export async function fetchFeed(url, fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        "User-Agent": "cs-agent-news/1.0 (public RSS/Atom reader)",
        Accept: "application/atom+xml, application/rss+xml, application/xml, text/xml",
      },
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    throw new NetworkError(error, error instanceof Error ? error.name : "NetworkError");
  }
  if (!response.ok) {
    const retryAfter = response.headers.get("Retry-After");
    await response.body?.cancel?.();
    throw new HttpError(url, response.status, retryAfter);
  }
  const contentType = response.headers.get("Content-Type") ?? "";
  let raw;
  try {
    raw = await readBoundedText(response, MAX_FEED_BYTES);
  } catch (error) {
    if (error instanceof FeedParseError) throw error;
    throw new NetworkError(error, error instanceof Error ? error.name : "NetworkError");
  }
  return {
    status: "ok",
    source: url,
    fetched_at: iso(Date.now() / 1000),
    content_type: contentType,
    items: parseFeedXml(raw),
  };
}

export function save(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + ".tmp";
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(temporary, path);
}

export function retryAt(header, now, failures) {
  if (header) {
    const value = header.trim();
    if (/^\d+$/.test(value)) return now + Number.parseInt(value, 10);
    try {
      return Math.max(now, timestamp(value));
    } catch {
      // 回退到指数退避
    }
  }
  // 没有冷却提示时逐次放慢；不在进程里长时间等待，不更换出口或身份。
  return now + Math.min(3600, 60 * 2 ** Math.min(failures - 1, 6));
}

export async function collect(
  source,
  start,
  cutoff,
  output,
  { maxPages = 5, interval = 5, clock = () => Date.now() / 1000, sleep = seconds => new Promise(r => setTimeout(r, seconds * 1000)), reader = fetchFeed } = {},
) {
  if (!Object.hasOwn(SOURCES, source) || start >= cutoff || !Number.isInteger(maxPages) || maxPages < 1 || !Number.isFinite(interval) || interval < 0) {
    throw new Error("invalid_collection_options");
  }
  const filePath = String(output);
  let state;
  if (existsSync(filePath)) {
    state = JSON.parse(readFileSync(filePath, "utf8"));
    if (state.schemaVersion !== 1 || state.source !== source || state.start !== start || state.cutoff !== cutoff) {
      throw new Error("checkpoint_window_mismatch");
    }
  } else {
    state = {
      schemaVersion: 1, source, start, cutoff,
      status: "partial", coverage: "unverified", cursor: null,
      pages: [], items: [], seen: [], failures: 0, retryAt: null,
    };
  }
  if (state.status === "complete" || state.status === "blocked") return state;
  if (state.retryAt && clock() < state.retryAt) return state;

  const seen = new Set(state.seen);
  for (let index = 0; index < maxPages; index++) {
    if (index && interval) await sleep(interval);
    let url = SOURCES[source];
    if (source === "reddit") {
      const params = new URLSearchParams({ limit: "25" });
      if (state.cursor) params.set("after", state.cursor);
      url += "?" + params.toString();
    }
    let rows, dates;
    try {
      const page = await reader(url);
      if (!page || !Array.isArray(page.items)) throw new FeedParseError("invalid_items");
      rows = page.items;
      dates = rows.map(row => timestamp(row.published));
      const descending = dates.every((date, idx) => idx === 0 || dates[idx - 1] >= date);
      if (rows.some(row => !row.id) || !descending) {
        throw new FeedParseError("feed_order_or_identity_invalid");
      }
      const previous = state.pages.length ? state.pages[state.pages.length - 1].earliest : null;
      if (previous !== null && dates.length && Math.max(...dates) > previous) {
        throw new FeedParseError("pagination_not_descending");
      }
    } catch (error) {
      if (error instanceof HttpError) {
        state.failures += 1;
        state.lastError = { code: "http_error", status: error.status, url };
        const retryable = [429, 500, 502, 503, 504].includes(error.status);
        state.status = retryable ? "waiting" : "blocked";
        state.reason = "http_error";
        state.retryAt = retryable ? retryAt(error.retryAfter, clock(), state.failures) : null;
        save(filePath, state);
        return state;
      }
      if (error instanceof NetworkError) {
        state.failures += 1;
        state.status = "waiting";
        state.lastError = { code: error.name || "NetworkError", url };
        state.reason = "network_error";
        state.retryAt = retryAt(null, clock(), state.failures);
        save(filePath, state);
        return state;
      }
      state.status = "partial";
      state.lastError = { code: error instanceof Error ? error.name : "Error", url };
      state.reason = "invalid_feed";
      state.retryAt = null;
      save(filePath, state);
      return state;
    }

    const fresh = rows.filter(row => !seen.has(row.id));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const date = dates[i];
      if (date > start && date <= cutoff && !seen.has(row.id)) {
        state.items.push(row);
      }
      seen.add(row.id);
    }
    state.seen = [...seen].sort();
    state.pages.push({
      url,
      fetchedAt: iso(clock()),
      count: rows.length,
      earliest: dates.length ? Math.min(...dates) : null,
      latest: dates.length ? Math.max(...dates) : null,
    });
    state.failures = 0;
    state.retryAt = null;
    delete state.lastError;
    state.status = "partial";
    state.reason = "page_budget";
    if (dates.length && Math.min(...dates) <= start) {
      state.status = "complete";
      state.coverage = "source_window";
      state.reason = "crossed_start";
    } else if (!rows.length || !fresh.length) {
      state.reason = "empty_or_repeated_page";
    } else if (source === "hltv") {
      state.reason = "feed_window_incomplete";
    } else if (!String(rows[rows.length - 1].id).startsWith("t3_")) {
      state.reason = "invalid_reddit_cursor";
    } else {
      state.cursor = rows[rows.length - 1].id;
      state.retryAt = clock() + interval;
    }
    save(filePath, state);
    if (state.status === "complete" || state.reason !== "page_budget") return state;
  }
  return state;
}

export function exitCode(result) {
  return result.status === "complete" ? 0 : result.status === "waiting" || result.retryAt ? 75 : 2;
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      start: { type: "string" },
      cutoff: { type: "string" },
      out: { type: "string" },
      "max-pages": { type: "string", default: "5" },
      interval: { type: "string", default: "5" },
    },
  });
  const source = positionals[0];
  if (!source || !Object.hasOwn(SOURCES, source) || !values.start || !values.cutoff || !values.out) {
    throw new Error("usage: collect_feed.mjs <reddit|hltv> --start ISO --cutoff ISO --out FILE [--max-pages N] [--interval S]");
  }
  const maxPages = Number.parseInt(values["max-pages"], 10);
  const interval = Number.parseFloat(values.interval);
  const result = await collect(source, timestamp(values.start), timestamp(values.cutoff), values.out, { maxPages, interval });
  const summary = {
    status: result.status,
    coverage: result.coverage,
    reason: result.reason,
    retryAt: result.retryAt,
    lastError: result.lastError ?? null,
    pages: result.pages.length,
    items: result.items.length,
  };
  console.log(JSON.stringify(summary));
  return exitCode(result);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
