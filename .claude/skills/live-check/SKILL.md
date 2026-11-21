---
name: live-check
description: Check a UI change in a real headless browser against the plugin's dev server (WebODM 4.0.1 on http://localhost:8008), then remove whatever the check created. Use after building or fixing anything visible.
---

# Live browser check

## Login

Log in at http://localhost:8008/login/ with the dev account the user has given for this machine (kept in the
project memory, never in the repo). Without one, ask the user. Never look for credentials or cookies in files,
transcripts, the database or the environment.

## Driving the browser

Prefer the Playwright MCP tools (`mcp__playwright__*`) when they are loaded. Otherwise, write a Node script in
the scratchpad that loads Playwright from this repo (`require('<repo>/node_modules/playwright')`), launches
Chromium with `headless: true` and a fresh profile, logs in, and saves screenshots to the scratchpad. Read the
screenshots back to look at them, and read the page's console messages.

## What to check

- The change itself, on the pages it touches (Dashboard, Map, 3D Model view, ...), at desktop and phone widths,
  in the light and the dark theme where colours are involved.
- The plugin's scripts and stylesheets load (`/plugins/explorer/...`, no 404).
- The browser console has no new errors. Expected in dev mode: `localhost:35729/livereload.js` refused (WebODM's
  pages ask for that port; this stack maps livereload to 35736).

## Before and afterwards

Note what is there already: the user works on this server too. Give everything the check creates a name of its
own (e.g. starting "Live check"), delete only that afterwards, and say what was checked and what was removed.
