#!/usr/bin/env node

/**
 * OpenTable Availability Monitor - Bar Leather Apron (Honolulu)
 *
 * Uses Puppeteer to automate browser-based availability checking.
 * This approach works around OpenTable's bot protection.
 *
 * Usage:
 *   node monitor.js                    # Single check
 *   node monitor.js --continuous       # Continuous monitoring
 *   node monitor.js --party=4          # Check for party of 4
 *   node monitor.js --days=14          # Check next 14 days
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  restaurant: {
    id: 193045,
    name: 'Bar Leather Apron',
    slug: 'bar-leather-apron-honolulu',
    url: 'https://www.opentable.com/r/bar-leather-apron-honolulu',
    // Restaurant is open Wed-Sat, 5pm-11:45pm
    openDays: [3, 4, 5, 6], // Wed=3, Thu=4, Fri=5, Sat=6
  },
  defaults: {
    partySize: 2,
    daysToCheck: 30,
    preferredTime: '19:00',
    checkIntervalMinutes: 30,
    concurrency: 6, // Number of parallel tabs (balance of speed vs resources)
  },
  notifications: {
    enabled: process.env.NOTIFY_EMAIL || process.env.SLACK_WEBHOOK,
    email: process.env.NOTIFY_EMAIL,
    slackWebhook: process.env.SLACK_WEBHOOK,
  },
  dataDir: path.join(__dirname, 'data'),
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  return {
    continuous: args.includes('--continuous') || args.includes('-c'),
    test: args.includes('--test'),
    headless: !args.includes('--visible'),
    partySize: parseInt(args.find(a => a.startsWith('--party='))?.split('=')[1]) || CONFIG.defaults.partySize,
    daysToCheck: parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1]) || CONFIG.defaults.daysToCheck,
    interval: parseInt(args.find(a => a.startsWith('--interval='))?.split('=')[1]) || CONFIG.defaults.checkIntervalMinutes,
    concurrency: parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || CONFIG.defaults.concurrency,
  };
}

// Process dates in parallel batches
async function processInParallel(items, concurrency, processor) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
}

// Generate dates to check (only open days)
function generateDates(daysOut) {
  const dates = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i <= daysOut; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    // Only include days the restaurant is open (Wed-Sat)
    if (CONFIG.restaurant.openDays.includes(date.getDay())) {
      dates.push(date);
    }
  }
  return dates;
}

// Format date for URL parameter
function formatDateForURL(date) {
  return date.toISOString().split('T')[0];
}

// Format date for display
function formatDateDisplay(date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// Check availability for a specific date
async function checkDateAvailability(page, date, partySize) {
  const dateStr = formatDateForURL(date);
  const url = `${CONFIG.restaurant.url}?p=${partySize}&sd=${dateStr}T${CONFIG.defaults.preferredTime}:00`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Wait for time slots to load
    await page.waitForSelector('[data-test="time-slots"], [data-test="availability-picker"], [data-test="times-702"], .timeslots, [data-test="availability"]', {
      timeout: 5000
    }).catch(() => null);

    // Give dynamic content time to render
    await page.waitForTimeout(2000);

    // Extract availability data
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

      // Method 2: Look for time slot buttons/links (but skip if we already found slots via Method 1)
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

      // Method 3: Look for time links only in specific containers (but skip if we already found slots)
      if (slots.length === 0) {
        const timeLinks = document.querySelectorAll('.oc-times-702 a, [data-test="availability"] > a');
        timeLinks.forEach(link => {
          const time = link.textContent?.trim();
          if (time && /^\d{1,2}:\d{2}\s?(AM|PM)?$/i.test(time)) {
            slots.push({ time, available: true, bookingUrl: link.href });
          }
        });
      }

      // Method 4: Check for "no availability" messages
      const noAvailText = document.body.innerText;
      const hasNoAvail = /no (times|availability|tables)/i.test(noAvailText) ||
                         /fully booked/i.test(noAvailText) ||
                         /sold out/i.test(noAvailText);

      // Method 5: Check for notify/waitlist buttons
      const hasNotifyButton = !!document.querySelector('[data-test*="notify"], .notify-me, button[class*="notify"]');

      return {
        slots: slots.filter((s, i, arr) => arr.findIndex(x => x.time === s.time) === i), // dedupe
        hasNoAvailabilityMessage: hasNoAvail && slots.length === 0,
        hasNotifyButton,
        pageText: document.body.innerText.substring(0, 500), // For debugging
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
      bookingUrl: url, // Include the booking URL for this date
    };
  } catch (error) {
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

// Save results to file
function saveResults(results, filename = 'availability.json') {
  if (!fs.existsSync(CONFIG.dataDir)) {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  }

  const filepath = path.join(CONFIG.dataDir, filename);
  const data = {
    timestamp: new Date().toISOString(),
    restaurant: CONFIG.restaurant.name,
    results,
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

// Load previous results for comparison
function loadPreviousResults() {
  const filepath = path.join(CONFIG.dataDir, 'availability.json');
  if (fs.existsSync(filepath)) {
    try {
      return JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

// Send notification (email/slack)
async function sendNotification(availableDates) {
  const message = `🎉 OpenTable Availability Found!\n\n` +
    `Restaurant: ${CONFIG.restaurant.name}\n` +
    `Available dates:\n` +
    availableDates.map(d => `  • ${d.dateDisplay}: ${d.slots.map(s => s.time).join(', ')}`).join('\n') +
    `\n\nBook now: ${CONFIG.restaurant.url}`;

  console.log('\n' + '='.repeat(50));
  console.log(message);
  console.log('='.repeat(50));

  // Slack webhook notification
  if (CONFIG.notifications.slackWebhook) {
    try {
      const https = require('https');
      const url = new URL(CONFIG.notifications.slackWebhook);

      const data = JSON.stringify({ text: message });

      const req = https.request({
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      req.write(data);
      req.end();
      console.log('Slack notification sent!');
    } catch (e) {
      console.error('Failed to send Slack notification:', e.message);
    }
  }

  // Email notification (requires nodemailer setup)
  if (CONFIG.notifications.email && process.env.SMTP_HOST) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: CONFIG.notifications.email,
        subject: `OpenTable: ${CONFIG.restaurant.name} Availability Found!`,
        text: message,
      });
      console.log('Email notification sent!');
    } catch (e) {
      console.error('Failed to send email:', e.message);
    }
  }
}

// Configure a page for fast loading
async function configurePage(page) {
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url();
    // Block images, fonts, analytics, and other non-essential resources
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

// Main monitoring function
async function runMonitor(options) {
  console.log('\n' + '='.repeat(60));
  console.log(`OpenTable Availability Monitor`);
  console.log(`Restaurant: ${CONFIG.restaurant.name}`);
  console.log(`Party Size: ${options.partySize}`);
  console.log(`Concurrency: ${options.concurrency} parallel tabs`);
  console.log(`Checking: ${options.daysToCheck} days (${new Date().toLocaleDateString()} - ${formatDateDisplay(new Date(Date.now() + options.daysToCheck * 86400000))})`);
  console.log('='.repeat(60) + '\n');

  // Launch browser
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: options.headless ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
  });

  // Create a pool of pages for parallel processing
  const pages = [];
  for (let i = 0; i < options.concurrency; i++) {
    const page = await browser.newPage();
    await configurePage(page);
    pages.push(page);
  }
  console.log(`Created ${pages.length} browser tabs for parallel checking\n`);

  const checkAll = async () => {
    const dates = generateDates(options.daysToCheck);
    const results = new Array(dates.length);
    const available = [];
    let completed = 0;

    console.log(`[${new Date().toLocaleString()}] Checking ${dates.length} dates with ${options.concurrency}x parallelism...\n`);
    const startTime = Date.now();

    // Process dates in parallel batches
    for (let i = 0; i < dates.length; i += options.concurrency) {
      const batch = dates.slice(i, Math.min(i + options.concurrency, dates.length));

      const batchPromises = batch.map(async (date, batchIdx) => {
        const pageIdx = batchIdx % pages.length;
        const globalIdx = i + batchIdx;

        const result = await checkDateAvailability(pages[pageIdx], date, options.partySize);
        results[globalIdx] = result;
        completed++;

        // Print result immediately
        const progress = `[${completed}/${dates.length}]`;
        if (result.error) {
          console.log(`${progress} ${result.dateDisplay}: ERROR - ${result.error}`);
        } else if (result.hasAvailability) {
          const times = result.slots.map(s => s.time).join(', ');
          console.log(`${progress} ${result.dateDisplay}: ✅ AVAILABLE - ${times}`);
          available.push(result);
        } else {
          console.log(`${progress} ${result.dateDisplay}: ❌ No availability`);
        }

        return result;
      });

      await Promise.all(batchPromises);

      // Small delay between batches to avoid rate limiting
      if (i + options.concurrency < dates.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\nCompleted in ${elapsed}s (${(dates.length / elapsed).toFixed(1)} dates/sec)`);

    // Save results
    const filepath = saveResults(results.filter(Boolean));
    console.log(`Results saved to: ${filepath}`);

    // Summary
    console.log('\n' + '-'.repeat(60));
    if (available.length > 0) {
      console.log(`\n🎉 AVAILABILITY FOUND! ${available.length} date(s) with open slots:\n`);
      available.forEach(a => {
        console.log(`  📅 ${a.dateDisplay}`);
        a.slots.forEach(s => console.log(`     └─ ${s.time}`));
      });
      console.log(`\n🔗 Book at: ${CONFIG.restaurant.url}\n`);

      await sendNotification(available);
    } else {
      console.log('\n😔 No availability found.');
      console.log('   Bar Leather Apron is very exclusive (6 seats only).');
      console.log('   Keep monitoring - cancellations happen!\n');
    }

    return { results: results.filter(Boolean), available };
  };

  try {
    if (options.continuous) {
      console.log(`🔄 Continuous mode enabled. Checking every ${options.interval} minutes.`);
      console.log('   Press Ctrl+C to stop.\n');

      while (true) {
        await checkAll();
        console.log(`\n⏰ Next check in ${options.interval} minutes...\n`);
        await new Promise(r => setTimeout(r, options.interval * 60 * 1000));
      }
    } else {
      const { available } = await checkAll();
      await browser.close();
      return available.length > 0 ? 0 : 1;
    }
  } catch (error) {
    console.error('Error:', error.message);
    await browser.close();
    return 1;
  }
}

// Entry point
const options = parseArgs();

if (options.test) {
  console.log('Configuration:', { ...CONFIG, ...options });
  console.log('\nDates to check:');
  generateDates(options.daysToCheck).forEach(d => console.log(`  ${formatDateDisplay(d)}`));
  process.exit(0);
}

runMonitor(options)
  .then(code => process.exit(code || 0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
