#!/bin/bash

# Check for any linked packages
LINKED=$(npm ls --link=true 2>/dev/null | grep -v 'npm ls' | grep '@')

if [ ! -z "$LINKED" ]; then
  echo "❌ ERROR: Found linked packages in node_modules!"
  echo "$LINKED"
  echo ""
  echo "Run: npm unlink <package> && npm install <package>"
  exit 1
else
  echo "✅ No linked packages found. Safe to deploy."
fi