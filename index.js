// index.js
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

// Allow only GitHub Pages origin
const ALLOWED_ORIGINS = ["https://gustavekstrm.github.io"];

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // e.g. curl
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "HEAD"],
}));

// Liveness check for Render
app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));

// Official FPL API base
const API_BASE = "https://fantasy.premierleague.com/api/";

// Cache policy helper
function cacheControlForPath(p) {
  const lower = (p || "").toLowerCase();
  if (lower.includes("/picks/") || lower.includes("live") || lower.startsWith("event")) {
    return "public, max-age=30";
  }
  return "public, s-maxage=300, stale-while-revalidate=60";
}

// Capture ALL under /api without wildcard syntax (Express 5 safe)
app.use("/api", async (req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    // Keep the path + query after /api/
    const pathWithQuery = req.originalUrl.replace(/^\/api\/?/, "");
    const targetUrl = new URL(pathWithQuery, API_BASE).toString();

    const upstream = await axios.get(targetUrl, {
      headers: {
        "User-Agent": req.get("User-Agent") || "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://fantasy.premierleague.com/"
      },
      validateStatus: () => true, // forward upstream status codes
    });

    res.set("Cache-Control", cacheControlForPath(pathWithQuery));
    res.status(upstream.status).json(upstream.data);
  } catch (err) {
    console.error("Proxy error:", err?.response?.status, err?.message);
    res.status(502).json({ error: "Upstream request failed", details: err?.message });
  }
});

// Final 404 (no wildcard syntax)
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`FPL proxy listening on ${PORT}`);
});
