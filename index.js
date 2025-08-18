const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = "https://fantasy.premierleague.com/api";

// Tillåt endast din frontend
const corsOptions = {
  origin: "https://gustavekstrm.github.io",
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Den här fångar ALLT efter /api/
app.get("/api/*", async (req, res) => {
  const apiPath = req.params[0]; // Fångar hela pathen efter /api/
  const targetUrl = `${API_BASE}/${apiPath}`;

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: "Proxy error",
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
