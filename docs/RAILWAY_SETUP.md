# 🚂 Railway Deployment Guide

This repository is fully tailored for [Railway.app](https://railway.app/). Due to the complex nature of WhatsApp Web Automation (Puppeteer, headless Chrome, memory watchdogs, and persistent login states), we leverage a **Hardened Dockerfile** and explicit volume permission fixing scripts that solve Railway's standard container quirks out of the box.

---

## One-Click Deployment (Recommended)

Because this repository contains a `railway.json` template definition, you can effortlessly launch the entire stack (The API + a Redis instance) using the **Railway Blueprint** mechanic simply by importing this repository.

1. Go to your **Railway Dashboard**.
2. Click **New Project** → **Deploy from GitHub repo**.
3. Select this repository.
4. Railway will automatically read `railway.json` and ask you to provision:
   - The primary application.
   - A linked Redis database.
   - It will **auto-generate** secure strings for your `API_KEY`, `API_SECRET`, and `ADMIN_KEY`.
   - It will **automatically attach** a persistent volume at `/app/chrome-data`.

---

## Manual Deployment Checklist

If you are setting this up manually inside an existing Railway project, ensure you follow these strict requirements:

### 1. Database Requirement: Redis
This API acts as a Queue Worker. **You must have a Redis plugin installed** in your Railway Environment.
- Deploy a Redis service in your Railway project.
- Expose its internal connection string to the WhatsApp API using the environment variable: `REDIS_URL`.

### 2. Builder Configuration
Do **NOT** use Railway's default Nixpacks builder. Puppeteer requires extensive OS-level dependencies (fonts, graphics libraries) that are tedious in Nixpacks.
- Go to **Settings** -> **Build** on your WhatsApp API service.
- Set the builder explicitly to **Dockerfile**. (The included `railway.toml` file attempts to enforce this automatically).

### 3. Critical Step: Persistent Storage (Volumes)
If you skip this, you will have to scan a new WhatsApp QR Code every time Railway deploys an update or restarts your container!
1. Go to your API Service settings in Railway.
2. Select the **Volumes** tab.
3. Create a New Volume and mount it to the absolute path: `/app/chrome-data`
4. *Note: Our `scripts/start.sh` automatically runs as root on startup to fix Railway's root-owned volume permissions before securely launching Node as `pptruser`. You do not need to worry about permission-denied errors.*

### 4. Memory Resource Limits
A headless chromium instance is memory-heavy.
- **Minimum RAM**: 512 MB.
- **Recommended RAM**: 1 GB.
> **Note:** We built a custom Memory Watchdog directly into `src/browser/browserManager.ts`. If your container memory starts hitting ~400MB, the system pauses the BullMQ job queue, gracefully restarts Chromium to dump memory leaks, and resumes the queue. This prevents Railway from OOM Killing your container mid-message.

### 5. Domains & Public Access
- Go to the **Settings** -> **Networking** tab.
- Click **Generate Domain**.
- Your webhook URL will be something like: `https://whatsapp-api-production.up.railway.app`

---

## Getting Logged In

Once the container is deployed and running on Railway:

1. Look at your **Deploy Logs**. You should see it cleanly boot, confirm the Redis connection, and state `Initializing browser`.
2. Generate an Admin QR Token to view your physical QR Code. On your local machine's terminal, run:
   ```bash
   npx ts-node src/utils/qr-helper.ts https://your-railway-app.railway.app
   ```
   *(It will read the `API_SECRET` and keys from your local `.env` to sign the auth request)*
3. The helper will output the QR Code directly to your terminal. Scan it with the WhatsApp app on your phone.
4. Check the Railway deploy logs again — you should see `Authenticated!` appear. Your session is now saved securely in the Railway Volume!
