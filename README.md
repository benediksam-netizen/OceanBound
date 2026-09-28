# Oceanbound – Fishing & Island Adventure (website)

A cozy 3D fishing game with live multiplayer: everyone who opens the site sails the same ocean.
Each player's progress (fish, coins, boats, house) is saved in their own browser.

| File | What it does |
|---|---|
| `index.html` | The game |
| `claude-shim.js` | Connects the game to this server's multiplayer |
| `server.js` | Serves the game and runs multiplayer (positions, chat, emotes, big-catch announcements) |
| `package.json` | Tells the host to install `ws` and run `node server.js` |
| `icon.png`, `og-image.jpg` | Browser icon and link preview picture |

## Hosting on Railway

1. Put these files in a GitHub repository (for example `oceanbound`).
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repository.
3. In the service's **Settings → Networking**, click **Generate Domain**.
4. Optional: add a variable `SITE_URL` with that address (used for the sitemap).

Railway runs `npm install` and `npm start` by itself and redeploys whenever the files change.
`/health` answers `ok` when the server is running.
