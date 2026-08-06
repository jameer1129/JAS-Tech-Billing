# JAS Tech Billing

JAS Tech Billing is a lightweight, offline-capable invoicing web app built with plain HTML, CSS and JavaScript. It helps small businesses create, save, and export professional invoices quickly — no server required.

## Key Features

- Customer management: name, address, phone
- Product management: add/edit/delete products, qty, price, serial, description
- Invoice generation: auto invoice numbers, invoice date, notes, line-item totals
- High-quality PDF export (A4) with company logo, signature, and configurable footer
- Optional offline support: a `service-worker.js` file is included, but the service worker is not registered by default. Optional Supabase sync is available for persistence.
- Usability: responsive UI, keyboard shortcuts, preview, and printable layouts

## Quick Start

1. Open the app in a browser (double-click `index.html` or serve the folder).
2. Configure company details in `config.json` (name, logo, colors, footer, default notes).
3. Create a bill: add customer details, add products, then Preview or Download PDF.

Notes:
- No build step required — the app runs locally in modern browsers.
- The repository includes `service-worker.js` for caching, but the app does not enable it automatically. To enable offline caching, register the service worker in `index.html` or serve the app as a PWA.

## Configuration

Edit `config.json` to set company info and appearance. Common keys:

- `company.name`
- `company.address`
- `company.phone`
- `assets.horizontalLogo` (path to logo used on invoices)
- `invoice.filePrefix` (PDF filename prefix)
- `invoice.defaultNotes`

Limitations:

- Customer name input is limited to 60 characters to ensure invoice layout and listings remain readable.

Changes in `config.json` are picked up when the page reloads; no code changes needed.

## Persistence & Optional Backend

- The app includes a service worker for offline caching, but it is not enabled by default. Data is stored locally in the browser while using the app; enable the service worker to cache assets for full offline loading.
- Optional Supabase integration is available (configure `CONFIG.supabase` in `config.json`) to save and list bills.

## File Structure

```
JAS-Tech-Billing/
├─ index.html            # Single-file app (UI + logic)
├─ config.json           # Company and app configuration
├─ service-worker.js     # Offline caching
├─ manifest.json         # PWA metadata
└─ assets/               # logos, icons, signatures
```

## Development

- Edit `index.html` to change UI or behavior (the app is intentionally single-file for portability).
- Run via a static server for best results (e.g., `npx http-server` or `python -m http.server`).

## Support & Contribution

If you want feature changes or help integrating Supabase backups, open an issue or contact the maintainers. Small, focused PRs are welcome.

## Privacy & Data

- Local-first: customer and invoice data are stored locally unless Supabase is configured.
- If using Supabase, ensure you configure and secure your project keys appropriately.

## License

This repository contains code developed for **JAS Tech**. For licensing or redistribution, contact the project owner.

---

If you want a shorter one-page README or a version tailored for distribution to customers, tell me which sections to highlight and I will produce that variant.