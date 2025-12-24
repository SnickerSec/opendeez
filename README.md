# OpenTable Availability Monitor

A production-ready web application to monitor OpenTable restaurant availability. Features a user-friendly interface, automated checking, and Docker deployment support.

## Features

- **Restaurant Search**: Search OpenTable directly from the interface
- **Flexible Configuration**: Party size, date range, days of week, check frequency
- **Two Modes**: Single check or continuous monitoring
- **Fast Parallel Checking**: Multiple browser tabs for speed
- **Production Ready**: Security headers, rate limiting, validation, logging, Docker support
- **Clickable Time Slots**: Click any available time to book directly on OpenTable

## Quick Start

### Prerequisites

- Node.js 18+ or Docker

### Option 1: Local Development

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start development server
npm run dev
```

Open http://localhost:3001

### Option 2: Docker (Recommended for Production)

```bash
# Build and run with Docker Compose
docker-compose up -d

# Or build manually
docker build -t opentable-monitor .
docker run -p 3001:3001 opentable-monitor
```

## Usage

1. Open http://localhost:3001
2. **Search** for a restaurant or paste an OpenTable URL
3. Configure party size, date range, and days of week
4. Click **"Check Once"** or **"Start Continuous Monitoring"**
5. Click any available time slot to book on OpenTable

### CLI Mode

```bash
# Single check with default settings
npm run cli

# Continuous monitoring
npm run monitor

# Custom options
npm run cli -- --party=4 --days=14
```

## API Reference

### Health Check
```
GET /health
```

### Search Restaurants
```
GET /api/search?query=restaurant+name+city
```

### Check Availability
```
POST /api/check
Content-Type: application/json

{
  "restaurantUrl": "https://www.opentable.com/r/restaurant-name",
  "restaurantName": "Restaurant Name",
  "partySize": 2,
  "daysToCheck": 30,
  "concurrency": 6,
  "openDays": [0, 1, 2, 3, 4, 5, 6]
}
```

### Start Monitoring
```
POST /api/monitor/start
```

### Stop Monitoring
```
POST /api/monitor/stop/:sessionId
```

### Get Results
```
GET /api/results/:sessionId
```

### List Sessions
```
GET /api/sessions
```

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Server port |
| `NODE_ENV` | development | Environment mode |
| `LOG_LEVEL` | info | Logging level |
| `MAX_CONCURRENCY` | 6 | Max parallel browser tabs |
| `MAX_DAYS_TO_CHECK` | 90 | Max days allowed |
| `RATE_LIMIT_WINDOW_MS` | 900000 | Rate limit window (15 min) |
| `RATE_LIMIT_MAX` | 100 | Max requests per window |
| `CORS_ORIGINS` | - | Allowed origins (production) |
| `SLACK_WEBHOOK` | - | Slack notification URL |
| `NOTIFY_EMAIL` | - | Email for notifications |

## Continuous Monitoring & Notifications

### How It Works

When you click **"Start Continuous Monitoring"**:

1. The server starts checking the restaurant at your specified interval (e.g., every 30 minutes)
2. Results are saved and displayed on the web interface
3. If availability is found, notifications are sent via Slack and/or Email
4. Monitoring continues until you click "Stop" or the server restarts

### Setting Up Notifications

#### Slack (Recommended - Easiest!)

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name it "OpenTable Monitor" and select your workspace
4. Go to **Incoming Webhooks** → Enable it
5. Click **Add New Webhook to Workspace**
6. Select the channel for notifications
7. Copy the webhook URL and set it as `SLACK_WEBHOOK` environment variable

#### Email (Gmail example)

1. Enable 2FA on your Google account
2. Go to [Google App Passwords](https://myaccount.google.com/apppasswords)
3. Create an app password for "Mail"
4. Set these environment variables:
   ```
   NOTIFY_EMAIL=your@email.com
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_USER=your@gmail.com
   SMTP_PASS=your-app-password
   ```

## Production Deployment

### Railway (Recommended for Easy Cloud Deployment)

1. **Create Railway Account**: [railway.app](https://railway.app)

2. **Deploy from GitHub**:
   ```bash
   # Push to GitHub first
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/yourusername/opentable-monitor.git
   git push -u origin main
   ```

3. **In Railway Dashboard**:
   - Click **New Project** → **Deploy from GitHub repo**
   - Select your repository
   - Railway auto-detects Node.js and deploys

4. **Set Environment Variables** (Railway Dashboard → Variables):
   ```
   SLACK_WEBHOOK=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
   ```

5. **Get Your URL**: Railway provides a free `*.railway.app` domain

That's it! Railway handles everything else automatically.

### Docker Compose

```bash
# Create production .env
cp .env.example .env
# Edit .env with production values

# Start
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Manual Deployment

```bash
# Install production dependencies
npm ci --only=production

# Set environment
export NODE_ENV=production

# Start
npm start
```

### Reverse Proxy (nginx)

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Security Features

- **Helmet.js**: Security headers (CSP, XSS protection, etc.)
- **Rate Limiting**: Prevents abuse (100 requests per 15 minutes)
- **Input Validation**: All inputs validated and sanitized
- **CORS**: Configurable for production
- **Non-root Docker**: Container runs as unprivileged user
- **Graceful Shutdown**: Clean resource cleanup

## Project Structure

```
opentable-monitor/
├── server.js           # Production Express server
├── monitor.js          # CLI monitoring tool
├── public/
│   └── index.html      # Web interface
├── data/               # Saved results
├── Dockerfile          # Production Docker image
├── docker-compose.yml  # Docker Compose config
├── package.json
├── .env.example
└── README.md
```

## Troubleshooting

### Browser Won't Launch
```bash
# Install Chrome dependencies (Linux)
apt-get install -y chromium fonts-liberation libxss1
```

### Rate Limited
- Reduce check frequency
- Increase `RATE_LIMIT_MAX` for trusted deployments

### Memory Issues
- Reduce `MAX_CONCURRENCY`
- Increase Docker memory limit

## License

MIT

## Disclaimer

For personal use only. Use reasonable check intervals. Respect OpenTable's terms of service.
