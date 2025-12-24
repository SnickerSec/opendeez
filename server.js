require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { body, query, validationResult } = require('express-validator');
const path = require('path');
const puppeteer = require('puppeteer');
const fs = require('fs');

// Logger setup
const winston = require('winston');
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Configuration
const CONFIG = {
  port: parseInt(process.env.PORT, 10) || 3001,
  env: process.env.NODE_ENV || 'development',
  corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3001'],
  maxConcurrency: parseInt(process.env.MAX_CONCURRENCY, 10) || 6,
  maxDaysToCheck: parseInt(process.env.MAX_DAYS_TO_CHECK, 10) || 90,
  checkInterval: 60, // Fixed 1-hour check interval (in minutes)
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 100
  }
};

// HTML escape utility to prevent XSS
const escapeHtml = (str) => {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

const app = express();
const dataDir = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Store active monitoring sessions and browser pool
const activeSessions = new Map();
let browserPool = null;

// Helper to generate a unique key for a monitoring config
function getMonitorKey(restaurantUrl, partySize, daysToCheck, openDays) {
  const normalizedUrl = restaurantUrl.split('?')[0].toLowerCase();
  const sortedDays = [...openDays].sort().join(',');
  return `${normalizedUrl}|${partySize}|${daysToCheck}|${sortedDays}`;
}

// Find existing session by monitor key
function findExistingSession(monitorKey) {
  for (const [sessionId, session] of activeSessions) {
    if (session.active && session.monitorKey === monitorKey) {
      return { sessionId, session };
    }
  }
  return null;
}

// ============================================
// Subscription Storage
// ============================================

const subscriptionsFile = path.join(dataDir, 'subscriptions.json');

// In-memory subscription data
let subscriptionsData = {
  subscriptions: {},
  byEmail: {},
  byToken: {}
};

// Generate unique subscription ID
function generateSubscriptionId() {
  return 'sub_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

// Generate unique unsubscribe token
function generateUnsubscribeToken() {
  return 'tok_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 12);
}

// Load subscriptions from disk
function loadSubscriptions() {
  try {
    if (fs.existsSync(subscriptionsFile)) {
      const data = fs.readFileSync(subscriptionsFile, 'utf8');
      subscriptionsData = JSON.parse(data);
      logger.info(`Loaded ${Object.keys(subscriptionsData.subscriptions).length} subscriptions from disk`);
    } else {
      logger.info('No subscriptions file found, starting fresh');
    }
  } catch (error) {
    logger.error('Error loading subscriptions:', error.message);
    subscriptionsData = { subscriptions: {}, byEmail: {}, byToken: {} };
  }
}

// Save subscriptions to disk
function saveSubscriptions() {
  try {
    fs.writeFileSync(subscriptionsFile, JSON.stringify(subscriptionsData, null, 2));
  } catch (error) {
    logger.error('Error saving subscriptions:', error.message);
  }
}

// Add subscription to indexes
function addSubscriptionToIndexes(subscription) {
  const { id, email, unsubscribeToken } = subscription;

  // Add to email index
  if (email) {
    if (!subscriptionsData.byEmail[email]) {
      subscriptionsData.byEmail[email] = [];
    }
    if (!subscriptionsData.byEmail[email].includes(id)) {
      subscriptionsData.byEmail[email].push(id);
    }
  }

  // Add to token index
  if (unsubscribeToken) {
    subscriptionsData.byToken[unsubscribeToken] = id;
  }
}

// Remove subscription from indexes
function removeSubscriptionFromIndexes(subscription) {
  const { id, email, unsubscribeToken } = subscription;

  // Remove from email index
  if (email && subscriptionsData.byEmail[email]) {
    subscriptionsData.byEmail[email] = subscriptionsData.byEmail[email].filter(subId => subId !== id);
    if (subscriptionsData.byEmail[email].length === 0) {
      delete subscriptionsData.byEmail[email];
    }
  }

  // Remove from token index
  if (unsubscribeToken) {
    delete subscriptionsData.byToken[unsubscribeToken];
  }
}

// Create a new subscription
function createSubscription(data) {
  const id = generateSubscriptionId();
  const unsubscribeToken = generateUnsubscribeToken();

  const subscription = {
    id,
    email: data.email || null,
    slackWebhook: data.slackWebhook || null,
    restaurantUrl: data.restaurantUrl,
    restaurantName: data.restaurantName || null,
    partySize: data.partySize || 2,
    daysToCheck: data.daysToCheck || 30,
    openDays: data.openDays || [0, 1, 2, 3, 4, 5, 6],
    unsubscribeToken,
    createdAt: new Date().toISOString(),
    lastNotified: null
  };

  subscriptionsData.subscriptions[id] = subscription;
  addSubscriptionToIndexes(subscription);
  saveSubscriptions();

  return subscription;
}

// Delete a subscription
function deleteSubscription(id) {
  const subscription = subscriptionsData.subscriptions[id];
  if (!subscription) return false;

  removeSubscriptionFromIndexes(subscription);
  delete subscriptionsData.subscriptions[id];
  saveSubscriptions();

  return true;
}

// Get subscription by token
function getSubscriptionByToken(token) {
  const id = subscriptionsData.byToken[token];
  return id ? subscriptionsData.subscriptions[id] : null;
}

// Get subscriptions by email
function getSubscriptionsByEmail(email) {
  const ids = subscriptionsData.byEmail[email.toLowerCase()] || [];
  return ids.map(id => subscriptionsData.subscriptions[id]).filter(Boolean);
}

// Get all subscriptions
function getAllSubscriptions() {
  return Object.values(subscriptionsData.subscriptions);
}

// Convert subscription to subscriber format
function subscriptionToSubscriber(subscription) {
  return {
    id: subscription.id,
    subscriptionId: subscription.id,
    slackWebhook: subscription.slackWebhook,
    notifyEmail: subscription.email,
    unsubscribeToken: subscription.unsubscribeToken,
    joinedAt: Date.now()
  };
}

// Start or join monitor for a subscription
async function startMonitorForSubscription(subscription) {
  const { restaurantUrl, restaurantName, partySize, daysToCheck, openDays } = subscription;
  const checkInterval = CONFIG.checkInterval;
  const concurrency = Math.min(6, CONFIG.maxConcurrency);

  const monitorKey = getMonitorKey(restaurantUrl, partySize, daysToCheck, openDays);
  const subscriber = subscriptionToSubscriber(subscription);

  // Check for existing session
  const existingSession = findExistingSession(monitorKey);
  if (existingSession) {
    const { sessionId, session } = existingSession;
    // Check if this subscription is already a subscriber
    const alreadySubscribed = session.subscribers.some(s => s.subscriptionId === subscription.id);
    if (!alreadySubscribed) {
      session.subscribers.push(subscriber);
      logger.info(`[${sessionId}] Subscription ${subscription.id} joined existing session (total: ${session.subscribers.length})`);
    }
    return sessionId;
  }

  // Create new session
  const sessionId = 'sub_' + Date.now().toString();
  const startTime = Date.now();

  logger.info(`Starting new monitor session ${sessionId} for subscription ${subscription.id}`);

  // Start monitoring in background
  (async () => {
    try {
      const browser = await getBrowser();
      const pages = [];

      for (let i = 0; i < concurrency; i++) {
        const page = await browser.newPage();
        await configurePage(page);
        pages.push(page);
      }

      activeSessions.set(sessionId, {
        pages,
        active: true,
        monitorKey,
        config: { restaurantUrl, restaurantName, partySize, daysToCheck, checkInterval, openDays },
        subscribers: [subscriber],
        startTime,
        isSubscriptionSession: true
      });

      const checkAll = async () => {
        const session = activeSessions.get(sessionId);
        if (!session || !session.active) return null;

        const dates = generateDates(daysToCheck, openDays);
        const results = [];
        const available = [];

        logger.info(`[${sessionId}] Checking ${dates.length} dates... (${session.subscribers.length} subscriber(s))`);

        for (let i = 0; i < dates.length; i += concurrency) {
          const batch = dates.slice(i, Math.min(i + concurrency, dates.length));

          const batchPromises = batch.map(async (date, batchIdx) => {
            const pageIdx = batchIdx % pages.length;
            const result = await checkDateAvailability(pages[pageIdx], date, partySize, restaurantUrl);
            return result;
          });

          const batchResults = await Promise.all(batchPromises);

          for (const result of batchResults) {
            results.push(result);
            if (result.hasAvailability) {
              available.push(result);
            }
          }
        }

        return { results, available };
      };

      // Main monitoring loop
      while (true) {
        const session = activeSessions.get(sessionId);

        // Check if session was stopped or has no more subscribers
        if (!session || !session.active || session.subscribers.length === 0) {
          logger.info(`[${sessionId}] Stopping subscription monitor (${!session ? 'deleted' : session.subscribers.length === 0 ? 'no subscribers' : 'stopped'})`);
          await Promise.all(pages.map(p => p.close().catch(() => {})));
          activeSessions.delete(sessionId);
          break;
        }

        const { available: foundSlots } = await checkAll() || {};
        if (foundSlots && foundSlots.length > 0) {
          logger.info(`[${sessionId}] Found ${foundSlots.length} available dates!`);
          // Notify all subscribers
          await sendNotification(restaurantName || restaurantUrl, foundSlots, restaurantUrl, session.subscribers);
        }

        logger.info(`[${sessionId}] Next check in ${checkInterval} minutes... (${session.subscribers.length} subscriber(s))`);
        await new Promise(r => setTimeout(r, checkInterval * 60 * 1000));
      }
    } catch (error) {
      logger.error(`[${sessionId}] Subscription monitor error:`, error.message);
      activeSessions.delete(sessionId);
    }
  })();

  return sessionId;
}

// Start monitors for all existing subscriptions on server startup
async function startAllSubscriptionMonitors() {
  const subscriptions = getAllSubscriptions();
  if (subscriptions.length === 0) {
    logger.info('No subscriptions to start monitors for');
    return;
  }

  logger.info(`Starting monitors for ${subscriptions.length} subscriptions...`);

  // Group subscriptions by monitor key to avoid duplicates
  const byMonitorKey = {};
  for (const sub of subscriptions) {
    const key = getMonitorKey(sub.restaurantUrl, sub.partySize, sub.daysToCheck, sub.openDays);
    if (!byMonitorKey[key]) {
      byMonitorKey[key] = [];
    }
    byMonitorKey[key].push(sub);
  }

  // Start one monitor per unique configuration
  for (const [key, subs] of Object.entries(byMonitorKey)) {
    // Start monitor for first subscription (others will join)
    await startMonitorForSubscription(subs[0]);
    // Add remaining subscriptions to the session
    for (let i = 1; i < subs.length; i++) {
      await startMonitorForSubscription(subs[i]);
    }
  }

  logger.info(`Started ${Object.keys(byMonitorKey).length} unique monitor sessions`);
}

// Load subscriptions on startup
loadSubscriptions();

// ============================================
// Middleware
// ============================================

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https://nominatim.openstreetmap.org"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS - use allowlist in all environments
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    const allowedOrigins = CONFIG.env === 'production'
      ? CONFIG.corsOrigins
      : [...CONFIG.corsOrigins, 'http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001'];
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Compression
app.use(compression());

// JSON parsing with limit
app.use(express.json({ limit: '10kb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: CONFIG.rateLimit.windowMs,
  max: CONFIG.rateLimit.max,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Static files with caching
app.use(express.static('public', {
  maxAge: CONFIG.env === 'production' ? '1d' : 0,
  etag: true
}));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info(`${req.method} ${req.path}`, {
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip
    });
  });
  next();
});

// ============================================
// Browser Pool Management
// ============================================

async function getBrowser() {
  if (!browserPool) {
    logger.info('Launching browser pool...');

    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--single-process',
        '--no-zygote'
      ],
    };

    // Use custom Chromium path if specified (for Railway/Docker)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      logger.info(`Using Chromium at: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    }

    browserPool = await puppeteer.launch(launchOptions);

    browserPool.on('disconnected', () => {
      logger.warn('Browser disconnected, will reconnect on next request');
      browserPool = null;
    });
  }
  return browserPool;
}

// ============================================
// Notification System
// ============================================

async function sendNotificationToSubscriber(restaurantName, availableDates, restaurantUrl, subscriber) {
  const slackWebhook = subscriber.slackWebhook;
  const notifyEmail = subscriber.notifyEmail;
  const unsubscribeToken = subscriber.unsubscribeToken;

  // Build unsubscribe URL if token exists
  const baseUrl = process.env.BASE_URL || `http://localhost:${CONFIG.port}`;
  const unsubscribeUrl = unsubscribeToken ? `${baseUrl}?unsubscribe=${unsubscribeToken}` : null;
  const unsubscribeText = unsubscribeUrl ? `\n\nTo unsubscribe: ${unsubscribeUrl}` : '';

  const message = `🎉 OpenTable Availability Found!\n\n` +
    `Restaurant: ${restaurantName}\n` +
    `Available dates:\n` +
    availableDates.map(d => `  • ${d.dateDisplay}: ${d.slots.map(s => s.time).join(', ')}`).join('\n') +
    `\n\nBook now: ${restaurantUrl}` + unsubscribeText;

  // Slack webhook notification
  if (slackWebhook) {
    try {
      const https = require('https');
      const url = new URL(slackWebhook);

      const slackMessage = {
        text: message,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "🎉 OpenTable Availability Found!" }
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Restaurant:* ${restaurantName}` }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Available Dates:*\n" + availableDates.map(d =>
                `• *${d.dateDisplay}*: ${d.slots.map(s => s.time).join(', ')}`
              ).join('\n')
            }
          },
          {
            type: "actions",
            elements: [{
              type: "button",
              text: { type: "plain_text", text: "Book Now" },
              url: restaurantUrl,
              style: "primary"
            }]
          }
        ]
      };

      const data = JSON.stringify(slackMessage);

      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
      }, (res) => {
        if (res.statusCode === 200) {
          logger.info(`Slack notification sent to subscriber ${subscriber.id}`);
        } else {
          logger.error(`Slack notification failed for ${subscriber.id}: ${res.statusCode}`);
        }
      });

      req.on('error', (e) => {
        logger.error(`Slack notification error for ${subscriber.id}:`, e.message);
      });

      req.write(data);
      req.end();
    } catch (e) {
      logger.error(`Failed to send Slack notification to ${subscriber.id}:`, e.message);
    }
  }

  // Email notification
  if (notifyEmail && process.env.SMTP_HOST) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      const safeUnsubscribeUrl = unsubscribeUrl ? encodeURI(unsubscribeUrl) : '';
      const unsubscribeHtml = safeUnsubscribeUrl
        ? `<p style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; font-size: 12px; color: #666;">
            <a href="${safeUnsubscribeUrl}" style="color: #666;">Unsubscribe from these notifications</a>
          </p>`
        : '';

      const safeRestaurantName = escapeHtml(restaurantName);
      const safeRestaurantUrl = encodeURI(restaurantUrl);

      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: notifyEmail,
        subject: `🎉 OpenTable: ${safeRestaurantName} Availability Found!`,
        text: message,
        html: `
          <h2>🎉 OpenTable Availability Found!</h2>
          <p><strong>Restaurant:</strong> ${safeRestaurantName}</p>
          <h3>Available Dates:</h3>
          <ul>
            ${availableDates.map(d => `<li><strong>${escapeHtml(d.dateDisplay)}:</strong> ${d.slots.map(s => escapeHtml(s.time)).join(', ')}</li>`).join('')}
          </ul>
          <p><a href="${safeRestaurantUrl}" style="background: #da3743; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Book Now</a></p>
          ${unsubscribeHtml}
        `,
      });
      logger.info(`Email notification sent to ${subscriber.id}`);
    } catch (e) {
      logger.error(`Failed to send email to ${subscriber.id}:`, e.message);
    }
  }
}

async function sendNotification(restaurantName, availableDates, restaurantUrl, subscribers = []) {
  if (availableDates.length === 0) return;

  logger.info(`Notification: ${availableDates.length} slots found for ${restaurantName}, notifying ${subscribers.length} subscriber(s)`);

  // Send to all subscribers
  for (const subscriber of subscribers) {
    if (subscriber.slackWebhook || subscriber.notifyEmail) {
      await sendNotificationToSubscriber(restaurantName, availableDates, restaurantUrl, subscriber);
    }
  }

  // Also send to global env webhooks if configured and no subscribers
  if (subscribers.length === 0) {
    const globalSubscriber = {
      id: 'global',
      slackWebhook: process.env.SLACK_WEBHOOK,
      notifyEmail: process.env.NOTIFY_EMAIL
    };
    if (globalSubscriber.slackWebhook || globalSubscriber.notifyEmail) {
      await sendNotificationToSubscriber(restaurantName, availableDates, restaurantUrl, globalSubscriber);
    }
  }
}

async function sendExpiryNotificationToSubscriber(restaurantName, sessionDuration, subscriber) {
  const slackWebhook = subscriber.slackWebhook;
  const notifyEmail = subscriber.notifyEmail;

  const message = `⏰ OpenTable Monitoring Session Expired\n\n` +
    `Restaurant: ${restaurantName}\n` +
    `Duration: ${sessionDuration} hours\n\n` +
    `Your monitoring session has ended. Start a new session if you'd like to continue monitoring.`;

  // Slack notification
  if (slackWebhook) {
    try {
      const https = require('https');
      const url = new URL(slackWebhook);

      const slackMessage = {
        text: message,
        blocks: [
          {
            type: "header",
            text: { type: "plain_text", text: "⏰ Monitoring Session Expired" }
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Restaurant:* ${restaurantName}\n*Duration:* ${sessionDuration} hours` }
          },
          {
            type: "section",
            text: { type: "mrkdwn", text: "Your monitoring session has ended. Start a new session if you'd like to continue monitoring." }
          }
        ]
      };

      const data = JSON.stringify(slackMessage);

      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
      }, (res) => {
        if (res.statusCode === 200) {
          logger.info(`Slack expiry notification sent to ${subscriber.id}`);
        } else {
          logger.error(`Slack expiry notification failed for ${subscriber.id}: ${res.statusCode}`);
        }
      });

      req.on('error', (e) => {
        logger.error(`Slack expiry notification error for ${subscriber.id}:`, e.message);
      });

      req.write(data);
      req.end();
    } catch (e) {
      logger.error(`Failed to send Slack expiry notification to ${subscriber.id}:`, e.message);
    }
  }

  // Email notification
  if (notifyEmail && process.env.SMTP_HOST) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT, 10) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: notifyEmail,
        subject: `⏰ OpenTable: ${restaurantName} Monitoring Expired`,
        text: message,
        html: `
          <h2>⏰ Monitoring Session Expired</h2>
          <p><strong>Restaurant:</strong> ${restaurantName}</p>
          <p><strong>Duration:</strong> ${sessionDuration} hours</p>
          <p>Your monitoring session has ended. Start a new session if you'd like to continue monitoring.</p>
        `,
      });
      logger.info(`Email expiry notification sent to ${subscriber.id}`);
    } catch (e) {
      logger.error(`Failed to send email expiry notification to ${subscriber.id}:`, e.message);
    }
  }
}

async function sendExpiryNotification(restaurantName, sessionDuration, subscribers = []) {
  logger.info(`Sending expiry notification for ${restaurantName} to ${subscribers.length} subscriber(s)`);

  for (const subscriber of subscribers) {
    if (subscriber.slackWebhook || subscriber.notifyEmail) {
      await sendExpiryNotificationToSubscriber(restaurantName, sessionDuration, subscriber);
    }
  }

  // Also send to global env webhooks if no subscribers
  if (subscribers.length === 0) {
    const globalSubscriber = {
      id: 'global',
      slackWebhook: process.env.SLACK_WEBHOOK,
      notifyEmail: process.env.NOTIFY_EMAIL
    };
    if (globalSubscriber.slackWebhook || globalSubscriber.notifyEmail) {
      await sendExpiryNotificationToSubscriber(restaurantName, sessionDuration, globalSubscriber);
    }
  }
}

async function closeBrowser() {
  if (browserPool) {
    await browserPool.close();
    browserPool = null;
    logger.info('Browser pool closed');
  }
}

// ============================================
// Helper Functions
// ============================================

function generateDates(daysOut, openDays = [0, 1, 2, 3, 4, 5, 6]) {
  const dates = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i <= daysOut; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    if (openDays.includes(date.getDay())) {
      dates.push(date);
    }
  }
  return dates;
}

function formatDateForURL(date) {
  return date.toISOString().split('T')[0];
}

function formatDateDisplay(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

async function configurePage(page) {
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url();
    if (['image', 'stylesheet', 'font', 'media'].includes(type) ||
        url.includes('google-analytics') ||
        url.includes('googletagmanager') ||
        url.includes('facebook') ||
        url.includes('doubleclick')) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

async function checkDateAvailability(page, date, partySize, restaurantUrl, preferredTime = '19:00') {
  const dateStr = formatDateForURL(date);
  const url = `${restaurantUrl}?p=${partySize}&sd=${dateStr}T${preferredTime}:00`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    await page.waitForSelector('[data-test="time-slots"], [data-test="availability-picker"], [data-test="times-702"], .timeslots, [data-test="availability"]', {
      timeout: 5000
    }).catch(() => null);

    await page.waitForTimeout(2000);

    const availability = await page.evaluate(() => {
      const slots = [];

      // Method 1: New OpenTable format with data-test="time-slot-X"
      const timeSlotContainer = document.querySelector('[data-test="time-slots"]');
      if (timeSlotContainer) {
        const timeSlotElements = timeSlotContainer.querySelectorAll('[data-test^="time-slot-"]');
        timeSlotElements.forEach(slotEl => {
          const link = slotEl.querySelector('a');
          if (link) {
            const time = link.textContent?.trim();
            if (time && /\d{1,2}:\d{2}/.test(time)) {
              slots.push({
                time: time,
                available: true,
                bookingUrl: link.href || ''
              });
            }
          }
        });
      }

      // Method 2: Fallback for other formats
      if (slots.length === 0) {
        const timeButtons = document.querySelectorAll('button[data-time], .timeslot-btn');
        timeButtons.forEach(btn => {
          const time = btn.textContent?.trim() || btn.getAttribute('data-time');
          if (time && /^\d{1,2}:\d{2}\s?(AM|PM)?$/i.test(time)) {
            slots.push({
              time: time,
              available: !btn.disabled && !btn.classList.contains('disabled'),
            });
          }
        });
      }

      // Method 3: Another fallback
      if (slots.length === 0) {
        const timeLinks = document.querySelectorAll('.oc-times-702 a, [data-test="availability"] > a');
        timeLinks.forEach(link => {
          const time = link.textContent?.trim();
          if (time && /^\d{1,2}:\d{2}\s?(AM|PM)?$/i.test(time)) {
            slots.push({ time, available: true, bookingUrl: link.href });
          }
        });
      }

      const noAvailText = document.body.innerText;
      const hasNoAvail = /no (times|availability|tables)/i.test(noAvailText) ||
                         /fully booked/i.test(noAvailText) ||
                         /sold out/i.test(noAvailText);

      const hasNotifyButton = !!document.querySelector('[data-test*="notify"], .notify-me, button[class*="notify"]');

      return {
        slots: slots.filter((s, i, arr) => arr.findIndex(x => x.time === s.time) === i),
        hasNoAvailabilityMessage: hasNoAvail && slots.length === 0,
        hasNotifyButton,
      };
    });

    return {
      date: dateStr,
      dateDisplay: formatDateDisplay(date),
      partySize,
      slots: availability.slots.filter(s => s.available),
      hasAvailability: availability.slots.some(s => s.available),
      noAvailabilityConfirmed: availability.hasNoAvailabilityMessage,
      hasNotifyButton: availability.hasNotifyButton,
      bookingUrl: url,
    };
  } catch (error) {
    logger.error(`Error checking ${dateStr}:`, error.message);
    return {
      date: dateStr,
      dateDisplay: formatDateDisplay(date),
      partySize,
      error: error.message,
      slots: [],
      hasAvailability: false,
      bookingUrl: url,
    };
  }
}

// Validation middleware helpers
const validateUrl = (url) => {
  try {
    const parsed = new URL(url);
    // Strict hostname check - must be exactly opentable.com or a subdomain
    const hostname = parsed.hostname.toLowerCase();
    return hostname === 'opentable.com' || hostname.endsWith('.opentable.com');
  } catch {
    return false;
  }
};

// Validate sessionId to prevent path traversal attacks
const validateSessionId = (sessionId) => {
  // Session IDs should only contain alphanumeric chars and underscores (e.g., "sub_1234567890" or "1234567890")
  return typeof sessionId === 'string' && /^[a-zA-Z0-9_]+$/.test(sessionId);
};

// ============================================
// API Routes
// ============================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeSessions: activeSessions.size,
    browserActive: !!browserPool
  });
});

// Geocoding proxy endpoint (to avoid CORS issues with Nominatim)
app.get('/api/geocode',
  query('lat').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  query('lon').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { lat, lon } = req.query;

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`,
        {
          headers: {
            'User-Agent': 'OpenTableMonitor/1.0 (https://github.com/SnickerSec/opendeez)'
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Nominatim returned ${response.status}`);
      }

      const data = await response.json();
      res.json(data);
    } catch (error) {
      logger.error('Geocoding error:', error.message);
      res.status(502).json({ error: 'Geocoding service unavailable' });
    }
  }
);

// Search restaurants endpoint
app.get('/api/search',
  query('query').trim().notEmpty().withMessage('Search query is required'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { query: searchQuery } = req.query;

    try {
      const browser = await getBrowser();
      const page = await browser.newPage();

      try {
        await page.setViewport({ width: 1280, height: 800 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Search URL - location should already be included in the query text
        const searchUrl = `https://www.opentable.com/s?covers=2&dateTime=2025-01-01T19:00&term=${encodeURIComponent(searchQuery)}`;

        logger.info(`Searching OpenTable: ${searchUrl}`);
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);

        const restaurants = await page.evaluate(() => {
          const results = [];
          const links = document.querySelectorAll('a[href*="/r/"]');
          const seenUrls = new Set();

          links.forEach(link => {
            const url = link.href.split('?')[0].split('#')[0];

            if (!url.includes('/r/') || url.includes('#reviews') || seenUrls.has(url)) {
              return;
            }

            seenUrls.add(url);
            let name = '';

            const parentCard = link.closest('[class*="card"], [class*="result"], div');
            if (parentCard) {
              const heading = parentCard.querySelector('h1, h2, h3, h4');
              if (heading && heading.textContent.trim() && !heading.textContent.match(/^\(\d+\)$/)) {
                name = heading.textContent.trim();
              }
            }

            if (!name && link.textContent.trim() && link.textContent.trim().length > 3 && !link.textContent.match(/^\(\d+\)$/)) {
              name = link.textContent.trim();
            }

            if (!name) {
              const slug = url.split('/r/')[1];
              name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }

            let address = '';
            let cuisine = '';

            if (parentCard) {
              const addressEl = parentCard.querySelector('[class*="address"], [class*="location"], [class*="metro"]');
              address = addressEl?.textContent?.trim() || '';

              const cuisineEl = parentCard.querySelector('[class*="cuisine"], [class*="category"], [class*="type"]');
              cuisine = cuisineEl?.textContent?.trim() || '';
            }

            if (name && url.includes('/r/')) {
              results.push({
                name: name.substring(0, 100),
                url,
                address: address.substring(0, 100),
                cuisine: cuisine.substring(0, 50),
                slug: url.split('/r/')[1] || ''
              });
            }
          });

          return results;
        });

        const uniqueRestaurants = restaurants.filter((r, i, arr) =>
          arr.findIndex(x => x.url === r.url) === i
        ).slice(0, 10);

        res.json({
          query: searchQuery,
          results: uniqueRestaurants,
          count: uniqueRestaurants.length
        });

      } finally {
        await page.close();
      }

    } catch (error) {
      logger.error('Search error:', error);
      res.status(500).json({ error: 'Search failed. Please try again.' });
    }
  }
);

// Single check endpoint
app.post('/api/check',
  body('restaurantUrl').trim().notEmpty().withMessage('Restaurant URL is required').custom(validateUrl).withMessage('Must be a valid OpenTable URL'),
  body('partySize').optional().isInt({ min: 1, max: 20 }).withMessage('Party size must be between 1 and 20'),
  body('daysToCheck').optional().isInt({ min: 1, max: CONFIG.maxDaysToCheck }).withMessage(`Days to check must be between 1 and ${CONFIG.maxDaysToCheck}`),
  body('concurrency').optional().isInt({ min: 1, max: CONFIG.maxConcurrency }).withMessage(`Concurrency must be between 1 and ${CONFIG.maxConcurrency}`),
  body('openDays').optional().isArray().withMessage('Open days must be an array'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      restaurantUrl,
      restaurantName,
      partySize = 2,
      daysToCheck = 30,
      concurrency = Math.min(6, CONFIG.maxConcurrency),
      openDays = [0, 1, 2, 3, 4, 5, 6]
    } = req.body;

    try {
      const browser = await getBrowser();
      const pages = [];

      for (let i = 0; i < concurrency; i++) {
        const page = await browser.newPage();
        await configurePage(page);
        pages.push(page);
      }

      try {
        const dates = generateDates(daysToCheck, openDays);
        const results = [];
        const available = [];

        logger.info(`Checking ${dates.length} dates for ${restaurantName || restaurantUrl}`);

        for (let i = 0; i < dates.length; i += concurrency) {
          const batch = dates.slice(i, Math.min(i + concurrency, dates.length));

          const batchPromises = batch.map(async (date, batchIdx) => {
            const pageIdx = batchIdx % pages.length;
            const result = await checkDateAvailability(pages[pageIdx], date, partySize, restaurantUrl);

            if (result.hasAvailability) {
              available.push(result);
            }

            return result;
          });

          const batchResults = await Promise.all(batchPromises);
          results.push(...batchResults);

          if (i + concurrency < dates.length) {
            await new Promise(r => setTimeout(r, 500));
          }
        }

        res.json({
          timestamp: new Date().toISOString(),
          restaurantName: restaurantName || restaurantUrl,
          results,
          available,
          summary: {
            totalDays: results.length,
            availableDays: available.length,
          }
        });

      } finally {
        await Promise.all(pages.map(p => p.close()));
      }

    } catch (error) {
      logger.error('Check error:', error);
      res.status(500).json({ error: 'Check failed. Please try again.' });
    }
  }
);

// Get active monitors (for showing joinable sessions)
app.get('/api/monitors', (req, res) => {
  const monitors = Array.from(activeSessions.entries())
    .filter(([_, session]) => session.active)
    .map(([id, session]) => ({
      sessionId: id,
      restaurantName: session.config.restaurantName,
      restaurantUrl: session.config.restaurantUrl,
      partySize: session.config.partySize,
      daysToCheck: session.config.daysToCheck,
      checkInterval: session.config.checkInterval,
      openDays: session.config.openDays,
      subscriberCount: session.subscribers.length,
      startedAt: new Date(session.startTime).toISOString()
    }));
  res.json(monitors);
});

// Start monitoring endpoint (with shared session support)
app.post('/api/monitor/start',
  body('restaurantUrl').trim().notEmpty().withMessage('Restaurant URL is required').custom(validateUrl).withMessage('Must be a valid OpenTable URL'),
  body('partySize').optional().isInt({ min: 1, max: 20 }),
  body('daysToCheck').optional().isInt({ min: 1, max: CONFIG.maxDaysToCheck }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      restaurantUrl,
      restaurantName,
      partySize = 2,
      daysToCheck = 30,
      concurrency = Math.min(6, CONFIG.maxConcurrency),
      openDays = [0, 1, 2, 3, 4, 5, 6],
      slackWebhook = null,
      notifyEmail = null
    } = req.body;

    const checkInterval = CONFIG.checkInterval; // Fixed 1-hour interval

    // Generate monitor key to check for existing sessions
    const monitorKey = getMonitorKey(restaurantUrl, partySize, daysToCheck, openDays);
    const existingSession = findExistingSession(monitorKey);

    // Create subscriber object
    const subscriberId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
    const subscriber = {
      id: subscriberId,
      slackWebhook,
      notifyEmail,
      joinedAt: Date.now()
    };

    // If there's an existing session, add this user as a subscriber
    if (existingSession) {
      const { sessionId, session } = existingSession;
      session.subscribers.push(subscriber);

      logger.info(`[${sessionId}] New subscriber ${subscriberId} joined (total: ${session.subscribers.length})`);

      return res.json({
        sessionId,
        subscriberId,
        message: 'Joined existing monitoring session',
        isShared: true,
        subscriberCount: session.subscribers.length,
        config: session.config,
        notifications: { slack: !!slackWebhook, email: !!notifyEmail }
      });
    }

    // Create new session
    const sessionId = Date.now().toString();
    const startTime = Date.now();

    res.json({
      sessionId,
      subscriberId,
      message: 'Monitoring started',
      isShared: false,
      subscriberCount: 1,
      config: { restaurantUrl, restaurantName, partySize, daysToCheck, checkInterval, openDays },
      notifications: { slack: !!slackWebhook, email: !!notifyEmail }
    });

    // Start monitoring in background
    (async () => {
      try {
        const browser = await getBrowser();
        const pages = [];

        for (let i = 0; i < concurrency; i++) {
          const page = await browser.newPage();
          await configurePage(page);
          pages.push(page);
        }

        activeSessions.set(sessionId, {
          pages,
          active: true,
          monitorKey,
          config: { restaurantUrl, restaurantName, partySize, daysToCheck, checkInterval, openDays },
          subscribers: [subscriber],
          startTime
        });

        const checkAll = async () => {
          const session = activeSessions.get(sessionId);
          if (!session || !session.active) return null;

          const dates = generateDates(daysToCheck, openDays);
          const results = [];
          const available = [];

          logger.info(`[${sessionId}] Checking ${dates.length} dates... (${session.subscribers.length} subscriber(s))`);

          for (let i = 0; i < dates.length; i += concurrency) {
            const batch = dates.slice(i, Math.min(i + concurrency, dates.length));

            const batchPromises = batch.map(async (date, batchIdx) => {
              const pageIdx = batchIdx % pages.length;
              const result = await checkDateAvailability(pages[pageIdx], date, partySize, restaurantUrl);

              if (result.hasAvailability) {
                available.push(result);
                logger.info(`[${sessionId}] FOUND: ${result.dateDisplay} - ${result.slots.map(s => s.time).join(', ')}`);
              }

              return result;
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);

            if (i + concurrency < dates.length) {
              await new Promise(r => setTimeout(r, 500));
            }
          }

          const filepath = path.join(dataDir, `session-${sessionId}.json`);
          fs.writeFileSync(filepath, JSON.stringify({
            timestamp: new Date().toISOString(),
            restaurantName: restaurantName || restaurantUrl,
            results,
            available,
          }, null, 2));

          // Send notifications to all subscribers if availability found
          if (available.length > 0) {
            await sendNotification(restaurantName || restaurantUrl, available, restaurantUrl, session.subscribers);
          }

          return { results, available };
        };

        while (true) {
          const session = activeSessions.get(sessionId);

          // Check if session was stopped or has no more subscribers
          if (!session || !session.active || session.subscribers.length === 0) {
            logger.info(`[${sessionId}] Stopping monitoring (${!session ? 'deleted' : session.subscribers.length === 0 ? 'no subscribers' : 'user requested'})`);
            await Promise.all(pages.map(p => p.close().catch(() => {})));
            activeSessions.delete(sessionId);
            break;
          }

          const { available: foundSlots } = await checkAll() || {};
          if (foundSlots && foundSlots.length > 0) {
            logger.info(`[${sessionId}] Found ${foundSlots.length} available dates!`);
          }

          logger.info(`[${sessionId}] Next check in ${checkInterval} minutes... (${session.subscribers.length} subscriber(s))`);
          await new Promise(r => setTimeout(r, checkInterval * 60 * 1000));
        }
      } catch (error) {
        logger.error(`[${sessionId}] Error:`, error.message);
        activeSessions.delete(sessionId);
      }
    })();
  }
);

// Stop monitoring endpoint (stops entire session)
app.post('/api/monitor/stop/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = activeSessions.get(sessionId);

  if (session) {
    session.active = false;
    logger.info(`[${sessionId}] Session stopped by user (had ${session.subscribers.length} subscribers)`);
    res.json({ message: 'Monitoring stopped', subscribersNotified: session.subscribers.length });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Unsubscribe from monitoring (removes just this subscriber)
app.post('/api/monitor/unsubscribe/:sessionId/:subscriberId', (req, res) => {
  const { sessionId, subscriberId } = req.params;
  const session = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const subscriberIndex = session.subscribers.findIndex(s => s.id === subscriberId);
  if (subscriberIndex === -1) {
    return res.status(404).json({ error: 'Subscriber not found in this session' });
  }

  // Remove subscriber
  session.subscribers.splice(subscriberIndex, 1);
  logger.info(`[${sessionId}] Subscriber ${subscriberId} unsubscribed (${session.subscribers.length} remaining)`);

  // If no more subscribers, the monitoring loop will stop automatically
  res.json({
    message: 'Unsubscribed from monitoring',
    remainingSubscribers: session.subscribers.length,
    sessionWillStop: session.subscribers.length === 0
  });
});

// Get results endpoint
app.get('/api/results/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  // Validate sessionId to prevent path traversal
  if (!validateSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }

  const filename = `session-${sessionId}.json`;
  const filepath = path.resolve(dataDir, filename);

  // Defense in depth: ensure resolved path is within dataDir
  if (!filepath.startsWith(path.resolve(dataDir) + path.sep)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  if (fs.existsSync(filepath)) {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    res.json(data);
  } else {
    res.status(404).json({ error: 'No results found' });
  }
});

// Get all sessions endpoint
app.get('/api/sessions', (req, res) => {
  const sessions = Array.from(activeSessions.entries()).map(([id, session]) => ({
    sessionId: id,
    active: session.active,
    config: session.config,
    subscriberCount: session.subscribers?.length || 0,
    startedAt: session.startTime ? new Date(session.startTime).toISOString() : null
  }));
  res.json(sessions);
});

// ============================================
// Subscription Endpoints
// ============================================

// Subscribe to notifications
app.post('/api/subscribe',
  body('restaurantUrl').trim().notEmpty().withMessage('Restaurant URL is required').custom(validateUrl).withMessage('Must be a valid OpenTable URL'),
  body('email').optional().isEmail().withMessage('Must be a valid email'),
  body('slackWebhook').optional().isURL().withMessage('Must be a valid URL'),
  body('partySize').optional().isInt({ min: 1, max: 20 }),
  body('daysToCheck').optional().isInt({ min: 1, max: CONFIG.maxDaysToCheck }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, slackWebhook, restaurantUrl, restaurantName, partySize, daysToCheck, openDays } = req.body;

    // Must have at least one notification method
    if (!email && !slackWebhook) {
      return res.status(400).json({ error: 'Either email or Slack webhook is required' });
    }

    try {
      const subscription = createSubscription({
        email: email?.toLowerCase(),
        slackWebhook,
        restaurantUrl,
        restaurantName,
        partySize,
        daysToCheck,
        openDays
      });

      logger.info(`New subscription created: ${subscription.id} for ${restaurantUrl}`);

      // Start or join a monitoring session for this subscription
      await startMonitorForSubscription(subscription);

      res.json({
        success: true,
        subscriptionId: subscription.id,
        message: 'Subscribed successfully! You will be notified when availability is found.',
        unsubscribeToken: subscription.unsubscribeToken
      });
    } catch (error) {
      logger.error('Error creating subscription:', error.message);
      res.status(500).json({ error: 'Failed to create subscription' });
    }
  }
);

// Get subscriptions by email
app.get('/api/subscriptions/:email', (req, res) => {
  const email = req.params.email.toLowerCase();
  const subscriptions = getSubscriptionsByEmail(email);

  // Don't expose tokens in the response
  const safeSubscriptions = subscriptions.map(sub => ({
    id: sub.id,
    restaurantUrl: sub.restaurantUrl,
    restaurantName: sub.restaurantName,
    partySize: sub.partySize,
    daysToCheck: sub.daysToCheck,
    openDays: sub.openDays,
    createdAt: sub.createdAt,
    lastNotified: sub.lastNotified
  }));

  res.json({ subscriptions: safeSubscriptions });
});

// Unsubscribe via token (GET for email links)
app.get('/api/unsubscribe/:token', (req, res) => {
  const { token } = req.params;
  const subscription = getSubscriptionByToken(token);

  if (!subscription) {
    return res.status(404).json({ error: 'Subscription not found or already unsubscribed' });
  }

  const restaurantName = subscription.restaurantName || subscription.restaurantUrl;
  deleteSubscription(subscription.id);
  logger.info(`Subscription ${subscription.id} unsubscribed via token`);

  res.json({
    success: true,
    message: `Successfully unsubscribed from notifications for ${restaurantName}`
  });
});

// Delete subscription by ID (from website)
app.delete('/api/subscription/:id', (req, res) => {
  const { id } = req.params;
  const subscription = subscriptionsData.subscriptions[id];

  if (!subscription) {
    return res.status(404).json({ error: 'Subscription not found' });
  }

  deleteSubscription(id);
  logger.info(`Subscription ${id} deleted`);

  res.json({
    success: true,
    message: 'Subscription deleted successfully'
  });
});

// Get all subscriptions (admin endpoint)
app.get('/api/subscriptions', (req, res) => {
  const subscriptions = getAllSubscriptions().map(sub => ({
    id: sub.id,
    email: sub.email,
    restaurantUrl: sub.restaurantUrl,
    restaurantName: sub.restaurantName,
    partySize: sub.partySize,
    daysToCheck: sub.daysToCheck,
    openDays: sub.openDays,
    createdAt: sub.createdAt,
    lastNotified: sub.lastNotified
  }));

  res.json({ subscriptions, total: subscriptions.length });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err);
  res.status(500).json({
    error: CONFIG.env === 'production' ? 'Internal server error' : err.message
  });
});

// ============================================
// Server Startup & Graceful Shutdown
// ============================================

const server = app.listen(CONFIG.port, async () => {
  logger.info(`OpenTable Monitor Server running on http://localhost:${CONFIG.port}`);
  logger.info(`Environment: ${CONFIG.env}`);

  // Start monitors for existing subscriptions
  setTimeout(() => {
    startAllSubscriptionMonitors().catch(err => {
      logger.error('Failed to start subscription monitors:', err.message);
    });
  }, 2000); // Delay to let server fully initialize
});

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} received, shutting down gracefully...`);

  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');

    // Stop all active monitoring sessions
    for (const [sessionId, session] of activeSessions) {
      session.active = false;
      logger.info(`Stopped session ${sessionId}`);
    }

    // Close browser pool
    await closeBrowser();

    logger.info('Shutdown complete');
    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection at:', promise, 'reason:', reason);
});
