# Matchday

A small installable web app (PWA) that shows the daily football slips produced by a Claude
research task. It is hosted on GitHub Pages, but the slips are **end-to-end encrypted**: only
the phone that set up the app can open them.

## How the privacy works

1. When you set up the app, your phone creates a key pair with the browser's built-in
   WebCrypto. The **private** key is stored on the phone only and is marked non-extractable
   where the browser supports it. It is never uploaded anywhere.
2. You give Claude the **public** key, which is saved in [`keys/`](keys/). A public key can only
   lock data, not unlock it, so it's safe for it to be public.
3. Each morning the research task writes the slips, then
   [`tools/publish.mjs`](tools/publish.mjs) encrypts them for every key in `keys/`
   (ECDH P-256, HKDF-SHA256, AES-256-GCM) and commits only the encrypted files
   (`data/latest.json`, `data/archive/<date>.json`).
4. The app downloads the encrypted file from this site and decrypts it on the phone.

Anyone who opens the site or this repository sees only encrypted data. What *is* visible is
that a report was published and when (from the commit history). The app loads nothing from
other websites, has no analytics, and enforces that with a strict Content-Security-Policy.

## Install on your phone

1. Open `https://nasclaude.github.io/matchday/` on your phone.
2. Add it to your home screen:
   - **iPhone:** in Safari tap **Share**, then **Add to Home Screen**.
   - **Android:** in Chrome tap **⋮**, then **Install app** or **Add to Home screen**.
3. Open **Matchday from the home screen** and tap **Set up this phone**. On iPhone the
   home-screen app has its own storage, so do this step there, not in Safari.
4. Tap **Copy key** and send the key to Claude. Claude saves it as `keys/phone.json`.
   From the next report on, your slips appear in the app.

If you delete the app or clear its data, the private key is gone. Set up again and replace
`keys/phone.json` with the new key. Earlier reports can't be opened with a new key.

## Files

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `styles.css` | The app. No build step, no dependencies. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Home-screen install and offline support. |
| `keys/` | Public keys of the devices allowed to read the slips. |
| `data/` | Encrypted reports, written by `tools/publish.mjs`. |
| `tools/publish.mjs` | Encrypts and publishes a report. `--self-test` checks the crypto. |
| `tools/SCHEMA.md` | The format the research task writes. |

## Updating the app

When you change `index.html`, `app.js`, `styles.css` or the icons, bump `VERSION` in `sw.js`
so installed copies pick up the new files.
