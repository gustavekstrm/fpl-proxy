# FPL Proxy

A Node.js proxy server for Fantasy Premier League (FPL) API requests.

## Description

This proxy server acts as an intermediary between FPL applications and the official FPL API, providing additional functionality and caching capabilities.

## Features

- CORS support for cross-origin requests
- Request/response logging
- Error handling
- JSON body parsing

## Installation

1. Clone the repository:

```bash
git clone https://github.com/yourusername/fpl-proxy.git
cd fpl-proxy
```

2. Install dependencies:

```bash
npm install
```

3. Start the server:

```bash
npm start
```

## Usage

The server runs on port 3000 by default. You can make requests to the FPL API through this proxy.

### Local Development

```bash
npm start
# Server will be available at http://localhost:3000
```

### Production Deployment

This project is configured for deployment on Render. See [RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md) for detailed instructions.

**Live URL:** https://orebrofpl.onrender.com

### Testing the Proxy

Test the proxy by accessing:

```
http://localhost:3000/api/bootstrap-static/
# or
https://orebrofpl.onrender.com/api/bootstrap-static/
```

## API Endpoints

The proxy forwards requests to the official FPL API endpoints.

## Dependencies

- Express.js - Web framework
- CORS - Cross-origin resource sharing
- Axios - HTTP client

## License

MIT
