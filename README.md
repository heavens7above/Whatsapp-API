# Hardened WhatsApp Automation Service

![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![License](https://img.shields.io/badge/license-ISC-green.svg)
![Status](https://img.shields.io/badge/status-Production%20Ready-success.svg)

A high-reliability, enterprise-grade interface for WhatsApp Web automation. Designed for stability in constrained environments (Docker, Railway) with a focus on ban avoidance, memory resilience, and "fail-closed" security.

---

## 🏗 System Architecture

This service is not a simple script; it is a **Queue-Worker Microservice**.

- **API Layer**: Express.js with HMAC security and Rate Limiting. Accepts requests and offloads them to Redis.
- **Job Queue**: BullMQ (Redis-backed) ensures no data loss. Jobs are processed serially (FIFO) to mimic human behavior.
- **Browser Engine**: Headless Chromium managed by Puppeteer.
  - **Stealth**: `puppeteer-extra-plugin-stealth` prevents fingerprinting.
  - **Memory Watchdog**: Auto-restarts browser if RSS memory > 400MB.
- **State Machine**: A rigorous FSM manages the session (`INIT` -> `QR` -> `AUTH` -> `BANNED`), featuring a **Quarantine** state to filter false-positive bans.

---

## 🚀 Installation

### Prerequisites

- Node.js v18+
- Redis (Required for Queue)
- Docker (Optional, Recommended)

### Option A: Local Development

1.  **Clone & Install**
    ```bash
    git clone <repo_url>
    cd whatsapp-automation-service
    npm install
    ```
2.  **Configure Environment**
    Copy `.env_example` to `.env` and fill in credentials:
    ```bash
    cp .env_example .env
    ```
3.  **Start Redis**
    Ensure a local Redis instance is running on port 6379.
4.  **Run Service**
    ```bash
    npm run dev
    ```

### Option B: Docker Production

The `Dockerfile` is optimized for production with Chrome dependencies pre-installed.

1.  **Build Image**
    ```bash
    docker build -t whatsapp-service .
    ```
2.  **Run Container**
    ```bash
    docker run -d \
      --name whatsapp-service \
      -p 3000:3000 \
      -v whatsapp-data:/app/chrome-data \
      --env-file .env \
      whatsapp-service
    ```
    _Note: The `-v` volume is critical for persisting the session (keeping you logged in)._

---

## ⚙️ Configuration

| Variable               | Description                          | Default                  |
| :--------------------- | :----------------------------------- | :----------------------- |
| `PORT`                 | API Listening Port                   | `3000`                   |
| `API_KEY`              | Simple Auth Key for API access       | **Required**             |
| `API_SECRET`           | Secret for HMAC signature generation | Optional                 |
| `ADMIN_KEY`            | Key for Admin routes (QR generation) | Optional                 |
| `REDIS_URL`            | Redis connection string              | `redis://localhost:6379` |
| `CHROME_USER_DATA_DIR` | Path to Chrome profile storage       | `chrome-data`            |

---

## 🔌 API Documentation

### 1. Send Text Message

**POST** `/send`

Queues a message for delivery. Returns immediately with Job ID.

**Headers:**

- `x-api-key`: YOUR_API_KEY
- `Content-Type`: `application/json`

**Body:**

```json
{
  "phone": "15551234567",
  "message": "Hello World from API",
  "idempotencyKey": "unique-req-id-123"
}
```

**Response (202 Accepted):**

```json
{
  "status": "queued",
  "jobId": "unique-req-id-123"
}
```

### 2. Generate QR Token (Admin)

**POST** `/admin/generate-qr-token`

Generates a short-lived (60s) access token to view the QR code. Rate limited to 5/hour per IP.

**Headers:**

- `x-admin-key`: YOUR_ADMIN_KEY

**Response:**

```json
{
  "qrAccessToken": "abc123token...",
  "expiresInSeconds": 60,
  "url": "/qr?token=abc123token..."
}
```

### 3. View QR Code

**GET** `/qr?token=...`

Returns the raw QR data string (for `qrcode` lib) or renders it. One-time use token.

---

## 🛡 Security & Resilience mechanics

### 1. Fail-Closed Logic

If Redis disconnects, the service **exits** rather than accepting requests it cannot persist. If a Ban is confirmed, the Queue **pauses** instantly to prevent further damage.

### 2. Intelligent Rate Limiting

- **Daily Cap**: Starts at 100 messages/day. Automatically ramps up by 50 messages per day of uptime, up to a hard cap of 2000.
- **Circuit Breaker**: If 5 messages fail sequentially, the system enters `CIRCUIT_OPEN` state for 5 minutes.

### 3. Memory Guard

A background watchdog monitors RSS memory usage. If usage exceeds **400MB** (common limit on free/starter PaaS), it triggers a graceful browser restart between jobs.

---

## ⚠️ Known Limitations

1.  **Single Session**: This architecture supports 1 active WhatsApp account per container.
    - _Scaling Strategy_: Deploy multiple containers, each with a distinct `CHROME_USER_DATA_DIR` volume and Queue Name.
2.  **DOM Fragility**: Relies on WhatsApp Web DOM structure. Major UI updates by Meta may require code patches to update CSS selectors.

---

## 🔮 Roadmap

- [ ] **Screenshot-on-Fail**: Upload failed state screenshots to S3 for easier debugging.
- [ ] **Webhooks**: Push notifications for `JobCompleted` or `JobFailed` events.
- [ ] **Multi-Session**: Support multiple browser contexts in a single container (High Resource Usage).

---

_Verified Engineering Quality._
