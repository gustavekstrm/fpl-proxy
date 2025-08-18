const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const API_BASE = "https://fantasy.premierleague.com/api";

app.use(cors());

app.get("/api/:path", async (req, res) => {
  const path = req.params.path;
  const targetUrl = `${API_BASE}/${path}`;
  try {
    const response = await axios.get(targetUrl);
    res.json(response.data);
  } catch (error) {
    res
      .status(error.response?.status || 500)
      .json({ error: "Proxy error", details: error.message });
  }
});

app.get("/api/:path/:subpath", async (req, res) => {
  const path = req.params.path;
  const subpath = req.params.subpath;
  const targetUrl = `${API_BASE}/${path}/${subpath}`;
  try {
    const response = await axios.get(targetUrl);
    res.json(response.data);
  } catch (error) {
    res
      .status(error.response?.status || 500)
      .json({ error: "Proxy error", details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on port ${PORT}`);
});
