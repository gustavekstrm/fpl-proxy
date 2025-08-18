# Render Deployment Guide

## Render Settings

When deploying to Render, use these exact settings:

### Build & Deploy Settings
- **Build Command:** `npm install`
- **Start Command:** `npm start`

### Environment Variables
- **PORT:** Will be automatically set by Render (no need to configure)

### Service Configuration
- **Environment:** Node
- **Region:** Choose closest to your users
- **Branch:** `main`
- **Root Directory:** Leave empty (default)

## Deployment Steps

1. Connect your GitHub repository to Render
2. Create a new **Web Service**
3. Select your `fpl-proxy` repository
4. Use the settings above
5. Deploy!

## Testing Your Deployment

Once deployed, test your proxy at:
```
https://orebrofpl.onrender.com/api/bootstrap-static/
```

This should return the FPL bootstrap-static data in JSON format.

## Local Testing

Before deploying, test locally:
```bash
npm start
# Then visit: http://localhost:3000/api/bootstrap-static/
```
