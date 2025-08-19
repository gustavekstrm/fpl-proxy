// index.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
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

// Keep-alive agents to reduce TLS handshakes and WAF suspicion
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });

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

function isSensitivePath(p) {
  const lower = (p || "").toLowerCase();
  return /\/picks\/|\/event\/\d+\/picks|live|^event/.test(lower);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Retry 429 / 5xx; for sensitive endpoints, also retry a single 403 (can be transient WAF)
// Non-sensitive 403 likely means private or forbidden; don't loop forever.
async function fetchUpstreamWithRetries(targetUrl, headers, { attempts = 3, sensitive = false } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await axios.get(targetUrl, {
        headers,
        httpAgent: keepAliveHttp,
        httpsAgent: keepAliveHttps,
        validateStatus: () => true,   // forward upstream codes
        timeout: 15000,
      });

      const s = resp.status;
      const retryable =
        s === 429 || s >= 500 || (s === 403 && sensitive); // retry 403 only for sensitive endpoints

      if (!retryable) return resp;
      if (i < attempts - 1) {
        const jitter = Math.floor(Math.random() * 300);
        await sleep(500 * (i + 1) + jitter);
        continue;
      }
      return resp; // last attempt: return as-is
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        const jitter = Math.floor(Math.random() * 300);
        await sleep(600 * (i + 1) + jitter);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// -------------------------------------------
// Main proxy handler (Express 5 safe, no wildcard syntax)
// -------------------------------------------
app.use("/api", async (req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // keep path + query after /api/
    const pathWithQuery = req.originalUrl.replace(/^\/api\/?/, "");
    // robust URL join; avoids double slashes and preserves query
    const targetUrl = new URL(pathWithQuery, API_BASE).toString();

    const UA =
      req.get("User-Agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

    const headers = {
      "User-Agent": UA,
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": req.get("Accept-Language") || "en-US,en;q=0.9",
      "Referer": "https://fantasy.premierleague.com/",
      "Origin": "https://fantasy.premierleague.com",
      "X-Requested-With": "XMLHttpRequest",
    };

    const sensitive = isSensitivePath(pathWithQuery);
    const upstream = await fetchUpstreamWithRetries(targetUrl, headers, { attempts: 3, sensitive });

    // Set caching hints (ours take precedence)
    res.set("Cache-Control", cacheControlForPath(pathWithQuery));

    // Forward a few useful upstream headers when present
    const etag = upstream.headers?.etag;
    const lastMod = upstream.headers?.["last-modified"];
    const ct = upstream.headers?.["content-type"];
    if (etag) res.set("ETag", etag);
    if (lastMod) res.set("Last-Modified", lastMod);
    if (ct) res.type(ct);

    // Log noisy upstream errors for observability
    if (upstream.status >= 400) {
      console.warn(`[proxy] ${upstream.status} ${targetUrl}`);
    }

    // Send body as-is; axios may give object (JSON) or string/buffer for HTML errors
    res.status(upstream.status).send(upstream.data);
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
