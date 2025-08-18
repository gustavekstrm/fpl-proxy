const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = "https://fantasy.premierleague.com/api";

// ✅ Tillåt endast frontend från GitHub Pages
const corsOptions = {
  origin: "https://gustavekstrm.github.io",
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// ✅ Fångar ALLA API-paths (oavsett djup)
app.get("/api/*", async (req, res) => {
  const targetPath = req.params[0]; // Allt efter /api/
  const targetUrl = `${API_BASE}/${targetPath}`;

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });
    res.json(response.data);
  } catch (error) {
    res
      .status(error.response?.status || 500)
      .json({ error: "Proxy error", details: error.message });
  }
});

// ✅ Starta servern
app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
