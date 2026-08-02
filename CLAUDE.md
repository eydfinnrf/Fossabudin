# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Fossábúðin** is a single-page grocery ordering website for a small shop
serving the Faroese islands of **Svínoy** and **Fugloy**. Customers browse
products by category, pick quantities, fill in their name/phone/address, and
submit an order. The order is delivered to the shop owner (and confirmed to the
customer) via a phone-code-verified **SMS** flow (Twilio, on Cloudflare).

The entire site is one hand-written file: `index.html`. All UI text is in
**Faroese** — keep it that way when editing copy.

## About me

I created a website for the shop and what would be best is that if the website was not depending on me personally, and if I could create an agent that will work for me in this website, and I could tell him when some products are not in stock or some new products are in stock and the agent will go inside the website and make the changes for me and if some new innovations in the website will come I can just tell it one of this and it will make it for me

# Rules
I Always ask at least three clarifying questions before starting any complex task.
Always present a plan before execution.
* Never make assumptions when important information is missing.
* Keep outputs concise and relevant.
* Do not add filler content to increase length.
* Stay within requested word counts and formats.
* Use practical examples whenever possible.
* When multiple approaches exist, explain the tradeoffs.
* If uncertain, ask before proceeding.
* Review outputs before final delivery.
# File Naming Rules
* Use lowercase file names.
* Use hyphens instead of spaces.
* Use descriptive names.
* Avoid special characters.

## Layout

- `index.html` — the whole app: inline CSS in `<style>`, product catalog as
  static HTML, and vanilla-JS logic in the `<script>` at the bottom
  (~line 3790+). No build step, no framework, no bundler.
- `cloudflare/` — the Cloudflare Workers backend: `src/send-order-sms.js`
  (Twilio SMS + phone-code verification, KV, Turnstile) and its `wrangler.toml`.
- `wrangler.jsonc` — config for the static-site Worker (serves `index.html` +
  `fossabudin-store.png` from `./dist`).
- `vorur/` — reference photos of products (`.HEIC`/`.PNG`). These are **not**
  linked from the site; they're a source library for the catalog. Do not assume
  editing them changes the page.
- `fossabudin-store.png`, `mjolk-raska.jpg.webp` — site imagery.
- `.claude/launch.json`, `.claude/serve.py` — local static-preview server on
  port 3456.

## How the order flow works (in `index.html`)

1. Products are static HTML grouped into ~30 categories (`.prod-category` with a
   `.prod-cat-label`). Items are either `.sub-item` rows or `.simple-qty-wrap`
   `.product-item` blocks, each with a quantity stepper.
2. Selecting an item toggles a `.chosen` class; there is no cart state object —
   the current order is derived by querying the DOM for `.chosen` elements.
3. `submitOrder()` builds a summary modal from the chosen items.
4. The summary modal is a two-step phone-verification flow: `requestCode()` runs
   an invisible Turnstile check and POSTs to the `fossabudin-sms` Worker
   (`/request-code`), which rate-limits and SMS-es a 6-digit code to the
   customer; `verifyOrder()` POSTs the code to `/verify-order`, which on success
   SMS-es the order to the shop owner + a confirmation to the customer.
5. Phone numbers must be +298 mobiles (6 digits starting 2/5/7/8). No EmailJS /
   gsm.fo in the order flow anymore (those constants in index.html are legacy).

## Key conventions

- Adding/renaming a product = editing static HTML in `index.html`. See git
  history (e.g. "Add ... products to ... category", "Rename ... category") for
  the established style — small, focused commits per catalog change.
- All customer-facing strings are Faroese. Match surrounding tone and spelling.
- Keep everything in the single file; do not introduce a framework or build
  tooling unless asked.

## Secrets & config

- **No secrets in the web app.** All secrets live as **Cloudflare Worker
  secrets** on `fossabudin-sms`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_PHONE`, `SHOP_OWNER_PHONE`, `TURNSTILE_SECRET`. Set them in the
  Cloudflare dashboard or via `wrangler secret put` — never hard-code them.
- The **EmailJS** keys still hard-coded in `index.html` are **legacy/unused**
  (the order flow no longer sends email).

## Running locally

- Serve the folder over HTTP (e.g. `python3 -m http.server`) and open
  `index.html`. The order flow calls the live `fossabudin-sms` Worker directly.
- The Turnstile bot-check only renders on domains registered for the widget
  (fossabudin.fo, dev.fossabudin.fo; add `localhost` temporarily to test locally).

## Deployment

Hosted on **Cloudflare** (not Netlify — that was the original setup and is gone).
Two-environment git workflow:
- **`dev` branch → `fossabudin-dev` Worker → dev.fossabudin.fo** (private,
  Access-gated). Auto-deploys on push. **Do all work/experiments here.**
- **`main` branch → `fossabudin` Worker → fossabudin.fo / www** (production).
  Updated only by merging `dev` → `main` when the owner approves.

The static site is served as Worker static assets (`index.html` +
`fossabudin-store.png`, copied into `./dist` by the build command). SMS +
verification run on the separate `fossabudin-sms` Worker. **Never push straight
to `main` — work on `dev`.**


## Core Workflow Rules

- **Always present a written plan and wait
for approval before beginning any multi-step task.**
## General Guidelines

- Keep responses concise and focused on the task at hand.
- Use Markdown formatting for any structured output unless otherwise specified.
- Ask clarifying questions before proceeding if a request is ambiguous.
- Do not make assumptions about scope - confirm boundaries before acting.
