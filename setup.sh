#!/bin/bash

# OpenTable Monitor Setup Script

echo "Setting up OpenTable Availability Monitor..."
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js 18+ required. You have $(node -v)"
    exit 1
fi

echo "✅ Node.js $(node -v) detected"

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ npm install failed"
    exit 1
fi

echo "✅ Dependencies installed"

# Create data directory
mkdir -p data
echo "✅ Data directory created"

# Test run
echo ""
echo "Running configuration test..."
node monitor.js --test

echo ""
echo "=========================================="
echo "Setup complete! Usage:"
echo ""
echo "  Single check:       npm start"
echo "  Continuous:         npm run monitor"
echo "  Custom party size:  node monitor.js --party=4"
echo "  Custom days:        node monitor.js --days=14"
echo "  Visible browser:    node monitor.js --visible"
echo ""
echo "For notifications, set environment variables:"
echo "  SLACK_WEBHOOK=https://hooks.slack.com/..."
echo "  NOTIFY_EMAIL=your@email.com"
echo "  SMTP_HOST, SMTP_USER, SMTP_PASS"
echo "=========================================="
