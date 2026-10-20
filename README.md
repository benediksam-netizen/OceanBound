# Oceanbound – Fishing & Island Adventure (website)

A cozy 3D fishing game with live multiplayer. On the title screen each player picks where to play:

- **Single player**: nobody else joins.
- **Public server**: four named servers (Coral Bay, Sunset Reef, Starfish Cove, Lagoon Lights), 20 sailors each. "Best server" fills one server to 12, then spreads people out; if every server is full another one opens by itself.
- **Private server**: one player creates it and gets a 6-letter code; friends join by typing the code (up to 10 sailors). An empty private server stays open for 30 minutes.

Optional Railway variables: `PUBLIC_CAP` (default 20), `PRIVATE_CAP` (default 10), `FILL_TARGET` (default 12).
Each player's progress (fish, coins, boats, house) is saved in their own browser.

| File | What it does |
|---|---|
| `index.html` | The game |
| `claude-shim.js` | Connects the game to this server's multiplayer |
| `server.js` | Serves the game and runs the public and private servers (positions, chat, emotes, big-catch announcements); `/api/servers` lists the public servers |
| `package.json` | Tells the host to install `ws` and run `node server.js` |
| `icon.png`, `og-image.jpg` | Browser icon and link preview picture |

## Hosting on Railway

1. Put these files in a GitHub repository (for example `oceanbound`).
2. In Railway: **New Project → Deploy from GitHub repo** → pick the repository.
3. In the service's **Settings → Networking**, click **Generate Domain**.
4. Optional: add a variable `SITE_URL` with that address (used for the sitemap).

Railway runs `npm install` and `npm start` by itself and redeploys whenever the files change.
`/health` answers `ok` when the server is running.
