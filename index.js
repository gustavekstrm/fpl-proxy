// index.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
// Version-safe lru-cache import for v10+ and older versions
let LRUCacheClass;
try {
  // v10+ exports { LRUCache }
  ({ LRUCache: LRUCacheClass } = require("lru-cache"));
} catch (_) {
  // very old versions may export the class as default/constructor
  const legacy = require("lru-cache");
  LRUCacheClass = legacy.LRUCache || legacy;
}
const http = require("http");
const https = require("https");

// -------------------------------------------
// Config
// -------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

// For Express behind Render's proxy (correct client IP for rate limiting)
app.set("trust proxy", 1);

// Allow ONLY GitHub Pages by default; can extend via env ALLOWED_ORIGINS="https://gustavekstrm.github.io,https://example.com"
const DEFAULT_ORIGINS = ["https://gustavekstrm.github.io"];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS.join(","))
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const API_BASE = process.env.FPL_API_BASE || "https://fantasy.premierleague.com/api/";

// ---- Upstream queue: low concurrency + spacing ----
const UPSTREAM_CONCURRENCY = Number(process.env.UPSTREAM_CONCURRENCY || 2);
const UPSTREAM_DELAY_MS = Number(process.env.UPSTREAM_DELAY_MS || 200);
let active = 0;
const q = [];
async function schedule(task) {
  return new Promise((resolve, reject) => {
    q.push({ task, resolve, reject });
    pump();
  });
}
async function pump() {
  if (active >= UPSTREAM_CONCURRENCY) return;
  const next = q.shift();
  if (!next) return;
  active++;
  try {
    const res = await next.task();
    next.resolve(res);
  } catch (e) {
    next.reject(e);
  } finally {
    active--;
    setTimeout(pump, UPSTREAM_DELAY_MS);
  }
}

// ---- Keep-alive agents ----
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });

// ---- In-memory cache with stale-if-error ----
const cache = new LRUCacheClass({
  max: 500,
  ttlAutopurge: true, // optional; v10 supports this flag
});

// TTLs
const TTL = {
  BOOTSTRAP: Number(process.env.TTL_BOOTSTRAP_MS || 15 * 60 * 1000),
  HISTORY:   Number(process.env.TTL_HISTORY_MS   || 5  * 60 * 1000),
  PICKS:     Number(process.env.TTL_PICKS_MS     || 60 * 1000),
  SUMMARY:   Number(process.env.TTL_SUMMARY_MS   || 24 * 60 * 60 * 1000)
};
// Stale horizon (serve last-good on error within this window)
const STALE_HOURS = Number(process.env.STALE_HOURS || 12);

const ck = (url) => `c:${url}`;
const now = () => Date.now();
function setCache(url, data, ttl) { cache.set(ck(url), { ts: now(), data }, { ttl }); }
function getFresh(url) { const v = cache.get(ck(url)); return v ? v.data : null; }
function getStale(url) {
  const v = cache.get(ck(url));
  if (!v) return null;
  if (now() - v.ts <= STALE_HOURS * 3600 * 1000) return v.data;
  return null;
}
function isSensitivePath(p) {
  const lower = (p || "").toLowerCase();
  return /\/picks\/|\/event\/\d+\/picks|live|^event/.test(lower);
}
function ttlFor(path) {
  const l = path.toLowerCase();
  if (l.includes("bootstrap-static")) return TTL.BOOTSTRAP;
  if (l.includes("/history")) return TTL.HISTORY;
  if (l.includes("/picks")) return TTL.PICKS;
  if (l.endsWith(`/entry/`) || /\/entry\/\d+\/$/.test(l)) return TTL.SUMMARY;
  return 2 * 60 * 1000; // default 2m
}

// ---- Upstream with retries + queue ----
async function fetchUpstream(targetUrl, headers, attempts = 3, sensitive = false) {
  return schedule(async () => {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        const resp = await axios.get(targetUrl, {
          headers,
          httpAgent: keepAliveHttp,
          httpsAgent: keepAliveHttps,
          validateStatus: () => true,
          timeout: 15000,
        });
        const s = resp.status;
        const retryable = (s === 429) || (s >= 500) || (s === 403 && sensitive);
        if (!retryable) return resp;
        last = resp;
      } catch (e) {
        last = e;
      }
      await new Promise(r => setTimeout(r, 500 * (i + 1) + Math.floor(Math.random()*300)));
    }
    throw last; // last response or error
  });
}

// -------------------------------------------
// Middleware
// -------------------------------------------
app.use(helmet({
  // API responses are read cross-origin by your site; don't block with CORP
  crossOriginResourcePolicy: false,
}));

app.use(compression());

// Tiny access logs (helpful on Render)
app.use(morgan("tiny"));

// Strict CORS
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // allow curl/postman
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "HEAD"],
}));

// Health & readiness
app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));
app.get("/readyz", (req, res) => res.status(200).json({ ready: true }));

// Light per-IP rate limit to avoid bursts that can trigger upstream WAF
// 300 req / min per IP is safe for ~51 picks + a few extra calls
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api", limiter);

// -------------------------------------------
// Helpers
// -------------------------------------------
function cacheControlForPath(p) {
  const lower = (p || "").toLowerCase();
  // live-ish endpoints → short cache
  if (lower.includes("/picks/") || lower.includes("live") || lower.startsWith("event")) {
    return "public, max-age=30";
  }
  // static-ish → longer cache, allow stale
  return "public, s-maxage=300, stale-while-revalidate=60";
}

// -------------------------------------------
// Aggregate endpoints
// -------------------------------------------

// /api/aggregate/summary?ids=1,2,3
app.get("/api/aggregate/summary", async (req, res) => {
  const ids = String(req.query.ids || "")
    .split(",").map(x => parseInt(x,10)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: "ids required" });

  const results = [];
  for (const id of ids) {
    const path = `entry/${id}/`;
    const url = new URL(path, API_BASE).toString();
    const headers = {
      "User-Agent": req.get("User-Agent") || "Mozilla/5.0",
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://fantasy.premierleague.com/",
      "Origin": "https://fantasy.premierleague.com",
      "X-Requested-With": "XMLHttpRequest",
    };
    try {
      const fresh = getFresh(url);
      if (fresh) { results.push({ id, ok: true, data: fresh }); continue; }
      const resp = await fetchUpstream(url, headers, 3, false);
      if (resp.status >= 200 && resp.status < 300) {
        setCache(url, resp.data, TTL.SUMMARY);
        results.push({ id, ok: true, data: resp.data });
      } else {
        const stale = getStale(url);
        if (stale) results.push({ id, ok: true, data: stale, stale: true, upstream: resp.status });
        else results.push({ id, ok: false, status: resp.status });
      }
    } catch (e) {
      const stale = getStale(url);
      if (stale) results.push({ id, ok: true, data: stale, stale: true, upstream: "ERR" });
      else results.push({ id, ok: false, status: "ERR" });
    }
  }
  res.json({ results });
});

// /api/aggregate/history?ids=1,2,3&gw=1
app.get("/api/aggregate/history", async (req, res) => {
  const ids = String(req.query.ids || "")
    .split(",").map(x => parseInt(x,10)).filter(Boolean);
  const gw = parseInt(req.query.gw, 10) || 1;
  if (!ids.length) return res.status(400).json({ error: "ids required" });

  const results = [];
  for (const id of ids) {
    const path = `entry/${id}/history/`;
    const url = new URL(path, API_BASE).toString();
    const headers = {
      "User-Agent": req.get("User-Agent") || "Mozilla/5.0",
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://fantasy.premierleague.com/",
      "Origin": "https://fantasy.premierleague.com",
      "X-Requested-With": "XMLHttpRequest",
    };
    try {
      const fresh = getFresh(url);
      const data = fresh ? fresh : (await fetchUpstream(url, headers, 3, false)).data;
      if (!fresh) setCache(url, data, TTL.HISTORY);
      const row = (data?.current || []).find(x => x.event === gw) || null;
      results.push({ id, ok: true, points: row?.points ?? null, raw: row || null });
    } catch (e) {
      const stale = getStale(url);
      if (stale) {
        const row = (stale?.current || []).find(x => x.event === gw) || null;
        results.push({ id, ok: true, points: row?.points ?? null, raw: row || null, stale: true });
      } else {
        results.push({ id, ok: false });
      }
    }
  }
  res.json({ results, gw });
});

// -------------------------------------------
// Main proxy handler (Express 5 safe, no wildcard syntax)
// -------------------------------------------
app.use("/api", async (req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const pathWithQuery = req.originalUrl.replace(/^\/api\/?/, "");
    const targetUrl = new URL(pathWithQuery, API_BASE).toString();
    const sensitive = isSensitivePath(pathWithQuery);
    const T = ttlFor(pathWithQuery);

    const UA = req.get("User-Agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const headers = {
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": req.get("Accept-Language") || "en-US,en;q=0.9",
      "Referer": "https://fantasy.premierleague.com/",
      "Origin": "https://fantasy.premierleague.com",
      "X-Requested-With": "XMLHttpRequest",
    };

    // Fresh cache hit?
    const fresh = getFresh(targetUrl);
    if (fresh) {
      res.set("X-Proxy-Cache", "HIT");
      res.set("Cache-Control", cacheControlForPath(pathWithQuery));
      return res.status(200).json(fresh);
    }

    // Fetch upstream using queue + retries
    let upstream;
    try { upstream = await fetchUpstream(targetUrl, headers, 3, sensitive); }
    catch (e) { upstream = e; }

    // If axios error (no status)
    if (!upstream || !upstream.status) {
      const stale = getStale(targetUrl);
      if (stale) {
        res.set("X-Proxy-Stale", "1");
        res.set("X-Proxy-Upstream-Status", "ERR");
        res.set("Cache-Control", cacheControlForPath(pathWithQuery));
        return res.status(200).json(stale);
      }
      throw upstream;
    }

    // Non-2xx from upstream
    if (upstream.status < 200 || upstream.status >= 300) {
      const stale = getStale(targetUrl);
      if (stale) {
        res.set("X-Proxy-Stale", "1");
        res.set("X-Proxy-Upstream-Status", String(upstream.status));
        res.set("Cache-Control", cacheControlForPath(pathWithQuery));
        return res.status(200).json(stale);
      }
      console.warn(`[proxy] ${upstream.status} ${targetUrl}`);
      res.set("Cache-Control", cacheControlForPath(pathWithQuery));
      return res.status(upstream.status).send(upstream.data);
    }

    // Success → cache & forward
    setCache(targetUrl, upstream.data, T);
    res.set("X-Proxy-Cache", "MISS");
    res.set("Cache-Control", cacheControlForPath(pathWithQuery));
    const etag = upstream.headers?.etag;
    const lastMod = upstream.headers?.["last-modified"];
    const ct = upstream.headers?.["content-type"];
    if (etag) res.set("ETag", etag);
    if (lastMod) res.set("Last-Modified", lastMod);
    if (ct) res.type(ct);
    return res.status(200).json(upstream.data);
  } catch (err) {
    console.error("Proxy error:", err?.response?.status || "", err?.message || err);
    res.status(502).json({ error: "Upstream request failed", details: err?.message || String(err) });
  }
});

// Final 404 (no wildcard patterns in Express 5)
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`FPL proxy listening on ${PORT}`);
});
