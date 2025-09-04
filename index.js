const express = require("express");
const cors = require("cors");
const axios = require("axios");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const http = require("http");
const https = require("https");

// lru-cache v10+/legacy safe import
let LRUCacheClass;
try { ({ LRUCache: LRUCacheClass } = require("lru-cache")); }
catch { const legacy = require("lru-cache"); LRUCacheClass = legacy.LRUCache || legacy; }

const app = express();
const PORT = process.env.PORT || 3000;
// Upstream bases
const UPSTREAM = process.env.UPSTREAM_BASE || "https://fantasy.premierleague.com";
const API_BASE = process.env.FPL_API_BASE || new URL("api/", UPSTREAM).toString();

// trust proxy
app.set("trust proxy", 1);

// CORS
const DEFAULT_ORIGINS = ["https://gustavekstrm.github.io", "http://localhost:3000"];
const ALLOWED_ORIGINS = (process.env.CORS_ALLOW_ORIGINS || DEFAULT_ORIGINS.join(","))
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(morgan("tiny"));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok = ALLOWED_ORIGINS.some(o => o === origin);
    return ok ? cb(null, true) : cb(new Error("CORS: origin not allowed"));
  },
  credentials: false,
  methods: ["GET", "HEAD", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "X-Requested-With"],
  maxAge: 86400,
}));
app.options("*", cors());
// Explicit Vary for proxies/CDN
app.use((req, res, next) => { res.setHeader("Vary", "Origin"); next(); });

// browser can read these
app.use((req, res, next) => {
  res.set("Access-Control-Expose-Headers", "X-Proxy-Cache,X-Proxy-Stale,X-Proxy-Upstream-Status,X-Proxy-Soft");
  next();
});

// health
const { version: PKG_VERSION } = require("./package.json");
app.get("/health", (req, res) => res.status(200).json({ ok: true, uptime: process.uptime(), version: PKG_VERSION }));
app.get("/healthz", (req, res) => res.status(200).json({ ok: true }));
app.get("/readyz",  (req, res) => res.status(200).json({ ready: true }));

// debug routes (non-production only)
if (process.env.NODE_ENV !== "production") {
  app.get("/debug/routes", (req, res) => {
    const routes = [];
    app._router.stack.forEach((m) => {
      if (m.route && m.route.path) {
        const methods = Object.keys(m.route.methods).filter(k => m.route.methods[k]);
        routes.push({ path: m.route.path, methods });
      }
    });
    res.json({ routes });
  });
}

// rate limit only under /api
app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// keep-alive agents
const keepAliveHttp = new http.Agent({ keepAlive: true, maxSockets: 50 });
const keepAliveHttps = new https.Agent({ keepAlive: true, maxSockets: 50 });

// upstream queue
const UPSTREAM_CONCURRENCY = Number(process.env.UPSTREAM_CONCURRENCY || 2);
const UPSTREAM_DELAY_MS = Number(process.env.UPSTREAM_DELAY_MS || 200);
let active = 0; const q = [];
async function schedule(task){ return new Promise((resolve,reject)=>{ q.push({task,resolve,reject}); pump(); }); }
async function pump(){ if(active>=UPSTREAM_CONCURRENCY) return; const next=q.shift(); if(!next) return;
  active++; try{ next.resolve(await next.task()); }catch(e){ next.reject(e); } finally{ active--; setTimeout(pump, UPSTREAM_DELAY_MS); } }

// cache + stale-if-error
const cache = new LRUCacheClass({ max: 500, ttlAutopurge: true });
const TTL = {
  BOOTSTRAP: Number(process.env.TTL_BOOTSTRAP_MS || 15 * 60 * 1000),
  HISTORY:   Number(process.env.TTL_HISTORY_MS   || 5  * 60 * 1000),
  PICKS:     Number(process.env.TTL_PICKS_MS     || 60 * 1000),
  SUMMARY:   Number(process.env.TTL_SUMMARY_MS   || 24 * 60 * 60 * 1000),
  ROWS:      60 * 1000,
};
const STALE_HOURS = Number(process.env.STALE_HOURS || 12);
const now = () => Date.now(); const ck = url => `c:${url}`;
function setCache(url, data, ttl){ cache.set(ck(url), { ts: now(), data }, { ttl }); }
function getFresh(url){ const v = cache.get(ck(url)); return v ? v.data : null; }
function getStale(url){ const v = cache.get(ck(url)); return v && (now()-v.ts)<=STALE_HOURS*3600*1000 ? v.data : null; }
function ttlFor(path){
  const l = path.toLowerCase();
  if (l.includes("bootstrap-static")) return TTL.BOOTSTRAP;
  if (l.includes("/history")) return TTL.HISTORY;
  if (l.includes("/picks")) return TTL.PICKS;
  if (l.endsWith(`/entry/`) || /\/entry\/\d+\/$/.test(l)) return TTL.SUMMARY;
  return 2 * 60 * 1000;
}
function cacheControlForPath(p){
  const l=(p||"").toLowerCase();
  if (l.includes("/picks/") || l.includes("live") || l.startsWith("event")) return "public, max-age=30";
  return "public, s-maxage=300, stale-while-revalidate=60";
}
function isSensitivePath(p){ return /\/picks\/|\/event\/\d+\/picks|live|^event/i.test(p||""); }

// header-variant upstream fetch with retries
async function fetchUpstream(targetUrl, headers, attempts=3, sensitive=false){
  return schedule(async () => {
    const pass1 = headers;
    const pass2 = { "User-Agent": headers["User-Agent"]||"Mozilla/5.0", "Accept":"application/json, text/plain, */*", "Accept-Language": headers["Accept-Language"]||"en-US,en;q=0.9" };
    let last;
    for (let i=0;i<attempts;i++){
      for (const h of [pass1, pass2]){
        try{
          const resp = await axios.get(targetUrl, { headers: h, httpAgent: keepAliveHttp, httpsAgent: keepAliveHttps, validateStatus:()=>true, timeout:15000 });
          const s = resp.status; const retryable = (s===429)||(s>=500)||(s===403 && sensitive);
          if (!retryable) return resp; last = resp;
        }catch(e){ last = e; }
      }
      await new Promise(r=>setTimeout(r, 500*(i+1)+Math.floor(Math.random()*300)));
    }
    throw last;
  });
}

// ============ Aggregates (no wildcards) ============
app.get("/api/aggregate/summary", async (req, res) => {
  const ids = String(req.query.ids||"").split(",").map(x=>parseInt(x,10)).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: "ids required" });
  const results=[];
  for (const id of ids){
    const path=`entry/${id}/`; const url=new URL(path, API_BASE).toString();
    const headers={"User-Agent": req.get("User-Agent")||"Mozilla/5.0","Accept":"application/json, text/plain, */*","Accept-Language": req.get("Accept-Language")||"en-US,en;q=0.9","Referer":"https://fantasy.premierleague.com/","Origin":"https://fantasy.premierleague.com","X-Requested-With":"XMLHttpRequest"};
    try{
      const fresh=getFresh(url);
      if (fresh){ results.push({id, ok:true, data:fresh}); continue; }
      const resp=await fetchUpstream(url, headers, 3, false);
      if (resp.status>=200 && resp.status<300){ setCache(url, resp.data, TTL.SUMMARY); results.push({id, ok:true, data:resp.data}); }
      else { const stale=getStale(url); if (stale) results.push({id, ok:true, data:stale, stale:true, upstream:resp.status}); else results.push({id, ok:false, status:resp.status}); }
    }catch{ const stale=getStale(url); if (stale) results.push({id, ok:true, data:stale, stale:true, upstream:"ERR"}); else results.push({id, ok:false, status:"ERR"}); }
  }
  res.json({ results });
});

app.get("/api/aggregate/history", async (req, res) => {
  const ids = String(req.query.ids||"").split(",").map(x=>parseInt(x,10)).filter(Boolean);
  const gw = parseInt(req.query.gw,10) || 1;
  if (!ids.length) return res.status(400).json({ error: "ids required" });
  const results=[];
  for (const id of ids){
    const path=`entry/${id}/history/`; const url=new URL(path, API_BASE).toString();
    const headers={"User-Agent": req.get("User-Agent")||"Mozilla/5.0","Accept":"application/json, text/plain, */*","Accept-Language": req.get("Accept-Language")||"en-US,en;q=0.9","Referer":"https://fantasy.premierleague.com/","Origin":"https://fantasy.premierleague.com","X-Requested-With":"XMLHttpRequest"};
    try{
      const fresh=getFresh(url); const data = fresh?fresh:(await fetchUpstream(url, headers, 3, false)).data;
      if (!fresh) setCache(url, data, TTL.HISTORY);
      const row=(data?.current||[]).find(x=>x.event===gw)||null;
      results.push({ id, ok:true, points:row?.points ?? null, raw:row||null });
    }catch{
      const stale=getStale(url); if (stale){ const row=(stale?.current||[]).find(x=>x.event===gw)||null; results.push({ id, ok:true, points:row?.points ?? null, raw:row||null, stale:true }); }
      else results.push({ id, ok:false });
    }
  }
  res.json({ results, gw });
});

// Specific rate limit + soft cache for rows
const rowsLimiter = rateLimit({ windowMs: 60*1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use("/api/aggregate/rows", rowsLimiter);

// New normalized rows endpoint
app.get("/api/aggregate/rows", async (req, res) => {
  const gw = parseInt(req.query.gw, 10);
  const ids = String(req.query.ids||"").split(",").map(x=>parseInt(x,10)).filter(Boolean);
  if (!gw || !ids.length) return res.status(400).json({ error: "gw and ids required" });

  const key = `rows:${gw}:${ids.slice().sort((a,b)=>a-b).join(',')}`;
  const cached = cache.get(key);
  if (cached) {
    res.set("X-Proxy-Cache", "HIT");
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return res.status(200).json(cached);
  }

  const headers={"User-Agent": req.get("User-Agent")||"Mozilla/5.0","Accept":"application/json, text/plain, */*","Accept-Language": req.get("Accept-Language")||"en-US,en;q=0.9","Referer":"https://fantasy.premierleague.com/","Origin":"https://fantasy.premierleague.com","X-Requested-With":"XMLHttpRequest"};

  try {
    // Fetch summaries and histories in batches; concurrency is governed by schedule() inside fetchUpstream
    const summaryUrls = ids.map(id => new URL(`entry/${id}/`, API_BASE).toString());
    const historyUrls = ids.map(id => new URL(`entry/${id}/history/`, API_BASE).toString());

    const [summaries, histories] = await Promise.all([
      Promise.all(summaryUrls.map(u => fetchUpstream(u, headers, 3, false).then(r=>r.data).catch(()=>null))),
      Promise.all(historyUrls.map(u => fetchUpstream(u, headers, 3, false).then(r=>r.data).catch(()=>null))),
    ]);

    const rows = ids.map((id, i) => {
      const s = summaries[i] || {};
      const h = histories[i] || {};
      const current = Array.isArray(h.current) ? h.current.find(x => x.event === gw) || null : null;
      const prev = Array.isArray(h.current) ? h.current.find(x => x.event === (gw-1)) || null : null;
      const playerName = [s.player_first_name, s.player_last_name].filter(Boolean).join(" ") || "";
      const teamName = s.name || "";
      const gwPoints = current?.points ?? null;
      const totalPoints = current?.total_points ?? null;
      const overallRank = current?.overall_rank ?? null;
      const prevOverallRank = prev?.overall_rank ?? null;
      return { entryId: id, playerName, teamName, gwPoints, totalPoints, overallRank, prevOverallRank };
    });

    cache.set(key, rows, { ttl: TTL.ROWS });
    res.set("X-Proxy-Cache", "MISS");
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    return res.status(200).json(rows);
  } catch (e) {
    console.warn('[proxy][upstream]', { error: e?.message });
    return res.status(502).json({ error: 'upstream' });
  }
});

// ============ Generic /api proxy (no wildcard) ============
app.use("/api", async (req, res) => {
  if (!["GET","HEAD","OPTIONS"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });

  try{
    const pathWithQuery = req.originalUrl.replace(/^\/api\/?/, "");
    const targetUrl = new URL(pathWithQuery, API_BASE).toString();
    const sensitive = isSensitivePath(pathWithQuery);
    const T = ttlFor(pathWithQuery);

    const UA = req.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    const headers = {
      "User-Agent": UA, "Accept": "application/json, text/plain, */*", "Accept-Language": req.get("Accept-Language")||"en-US,en;q=0.9",
      "Referer":"https://fantasy.premierleague.com/","Origin":"https://fantasy.premierleague.com","X-Requested-With":"XMLHttpRequest"
    };

    // cache hit
    const fresh=getFresh(targetUrl);
    if (fresh){ res.set("X-Proxy-Cache","HIT"); res.set("Cache-Control", cacheControlForPath(pathWithQuery)); return res.status(200).json(fresh); }

    // upstream
    let upstream; try{ upstream=await fetchUpstream(targetUrl, headers, 3, sensitive); }catch(e){ upstream=e; }

    // axios error
    if (!upstream || !upstream.status){
      const stale=getStale(targetUrl);
      if (stale){ res.set("X-Proxy-Stale","1"); res.set("X-Proxy-Upstream-Status","ERR"); res.set("Cache-Control", cacheControlForPath(pathWithQuery)); return res.status(200).json(stale); }
      throw upstream;
    }

    // non-2xx
    if (upstream.status<200 || upstream.status>=300){
      const stale=getStale(targetUrl);
      if (stale){ res.set("X-Proxy-Stale","1"); res.set("X-Proxy-Upstream-Status", String(upstream.status)); res.set("Cache-Control", cacheControlForPath(pathWithQuery)); return res.status(200).json(stale); }

      const l = pathWithQuery.toLowerCase();
      const softable = upstream.status===403 && (
        l.includes('bootstrap-static') ||
        l.includes('/history/') ||
        l.includes('/picks/') ||
        l.includes('leagues-classic') ||
        /^entry\/\d+\/?$/.test(l)
      );
      if (softable){
        res.set("X-Proxy-Soft","1"); res.set("X-Proxy-Upstream-Status","403"); res.set("Cache-Control", cacheControlForPath(pathWithQuery));
        if (l.includes('bootstrap-static')) {
          return res.status(200).json({
            events: [{ id: 1, is_current: true }],
            phases: [], teams: [],
            total_players: 0,
            elements: [], element_stats: [], element_types: []
          });
        }
        if (l.includes('leagues-classic')) {
          return res.status(200).json({
            league: { id: 0, name: "", created: null, closed: false },
            new_entries: { has_next: false, page: 1, results: [] },
            standings: { has_next: false, page: 1, results: [] }
          });
        }
        if (l.includes('/history/')) return res.status(200).json({ current: [], past: [], chips: [] });
        if (l.includes('/picks/'))   return res.status(200).json({ entry_history: null, picks: [] });
        return res.status(200).json({ player_first_name:"", player_last_name:"", name:"" });
      }

      console.warn(`[proxy] ${upstream.status} ${targetUrl}`);
      res.set("Cache-Control", cacheControlForPath(pathWithQuery));
      return res.status(upstream.status).send(upstream.data);
    }

    // success
    setCache(targetUrl, upstream.data, T);
    res.set("X-Proxy-Cache","MISS");
    res.set("Cache-Control", cacheControlForPath(pathWithQuery));
    const etag=upstream.headers?.etag, lastMod=upstream.headers?.["last-modified"], ct=upstream.headers?.["content-type"];
    if (etag) res.set("ETag", etag);
    if (lastMod) res.set("Last-Modified", lastMod);
    if (ct) res.type(ct);
    return res.status(200).json(upstream.data);

  }catch(err){
    console.error("Proxy error:", err?.response?.status||"", err?.message||err);
    return res.status(502).json({ error: "Upstream request failed", details: err?.message || String(err) });
  }
});

// final 404 (no wildcard path)
app.use((req,res)=> res.status(404).json({ error: "Not found" }));

app.listen(PORT, ()=> console.log(`FPL proxy listening on ${PORT}`));
