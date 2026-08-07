# JAS Tech Billing

JAS Tech Billing is an **online invoicing web app** built with plain HTML, CSS and JavaScript (single-file, no build step, no framework). It runs entirely in the browser and uses **Supabase** as its backend for authentication, user approval, and bill storage — an internet connection is required to log in, save invoices, and load previous bills.

## Key Features

**Authentication & Access Control**
- Email/password sign-up and login via Supabase Auth
- New accounts start as `pending` and must be approved by an admin before they can use the app
- Two roles: `admin` and `employee`, with row-level security enforced in the database
- Change password from within the app

**Billing**
- Customer details: name, address, mobile number
- Auto-generated invoice number (configurable format) and date
- Product line items: name, description, serial number, quantity, rate — with add/edit/delete
- Live summary: total items, total quantity, grand total
- Optional invoice notes and watermark, toggleable per invoice
- Preview the invoice exactly as it will look before generating it
- High-quality, automatically paginated **PDF export** (A4) with company logo, signature, QR code and footer, generated client-side via `html2pdf.js`
- Download or share the generated PDF directly

**Previous Bills**
- Save invoices to Supabase and browse them later
- Search by invoice number, customer name, or phone
- Filter by date range (today, yesterday, last 7 days, this month, last month, or a custom date)
- Sort by any column, with server-side pagination
- Reprint (regenerate PDF) or delete a saved bill

**Admin Panel**
- Approve or reject pending sign-ups
- View all users, their role, and their approval status
- Promote/demote roles and manage account status

**Appearance & Config**
- Light/dark theme toggle (persisted locally)
- All company info, branding colors, logos, currency symbol, and footer text are driven by `config.json` — no code changes needed to rebrand
- Responsive layout with a mobile drawer menu

## Quick Start

1. Serve the folder with a local web server (double-clicking `index.html` won't work correctly because it needs to `fetch()` `config.json` and load the Supabase client) — e.g. `npx http-server` or `python -m http.server`.
2. Set up your Supabase project using `schema.sql` (see below).
3. Fill in `config.json` with your company details and Supabase project URL/anon key.
4. Open the app, register an account, then promote yourself to `admin` in Supabase (see the commented-out SQL at the bottom of `schema.sql`) so you can approve future sign-ups.
5. Log in, add customer + product details, then Preview or Download the PDF.

## Configuration

Edit `config.json` to control company info, theming, and invoice content. Common keys:

- `company.name`, `company.addressLines`, `company.phone`, `company.email`
- `theme.light` / `theme.dark` (colors) and `theme.radius`
- `assets.*` — paths to logo, watermark, signature, WhatsApp QR
- `supabase.url`, `supabase.anonKey` — required for the app to function
- `invoice.currencySymbol`, `invoice.filePrefix`, `invoice.numberFormat`, `invoice.defaultNotes`
- `display.*` — toggle which optional sections appear on the invoice
- `services` — the row of feature icons shown in the invoice footer

Changes to `config.json` are picked up on page reload; no code changes needed.

**Limitation:** customer name input is capped at 60 characters to keep invoice layout and listings readable.

## Backend (Supabase)

Run `schema.sql` once in your Supabase project's SQL Editor. It creates:

- `profiles` — one row per user, tracking role (`admin`/`employee`) and approval status
- `bills` and `bill_items` — saved invoices and their line items
- A trigger that auto-creates a `profiles` row (as a pending employee) on sign-up
- Row Level Security policies so employees can only read/write what they're allowed to, and only admins can delete bills or manage users

## Asset Caching (Service Worker)

The app registers `service-worker.js` automatically on load. It does **not** make the app work offline — it only caches static images (logos, signature, icons) for faster repeat visits. HTML, JavaScript, CSS, and `config.json` are always fetched fresh from the network, and Supabase calls always require a live connection.

## File Structure

```
JAS-Tech-Billing/
├─ index.html            # Single-file app (UI + logic)
├─ config.json            # Company and app configuration
├─ manifest.json           # PWA metadata (installable app icon/name)
├─ service-worker.js       # Image asset caching only (not for offline use)
├─ schema.sql              # Supabase database schema, RLS policies, triggers
└─ assets/                 # logos, icons, signature, WhatsApp QR
```

## Development

- Edit `index.html` to change UI or behavior — the app is intentionally single-file for portability.
- Run via a static server for best results (e.g., `npx http-server` or `python -m http.server`).

## Support & Contribution

If you want feature changes or help with the Supabase backend, open an issue or contact the maintainers. Small, focused PRs are welcome.

## Privacy & Data

- All invoice and user data is stored in your configured Supabase project — there is no local-only mode.
- Secure your `config.json` Supabase keys appropriately; the anon key is safe to expose client-side only because access is restricted by Row Level Security policies in `schema.sql`.

## License

This repository contains code developed for **JAS Tech**. For licensing or redistribution, contact the project owner.