# Notice

Kurviq. Copyright (c) 2026 Fabian Wesner. MIT License, see [LICENSE](LICENSE).

Kurviq is built on **[Excalidraw](https://github.com/excalidraw/excalidraw)**
(MIT License, Copyright (c) 2020 Excalidraw) and uses
**[excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp)** (MIT License)
for the agent drawing tools. Kurviq is an independent, unofficial project: it
is not affiliated with, endorsed by or sponsored by Excalidraw. "Excalidraw"
and "Excalifont" are names of the Excalidraw project, used here only to say
what Kurviq is built on.

This repository does not contain Excalidraw's or excalidraw-mcp's code:
`npm run setup` clones them, unmodified, at the commits pinned in
`scripts/setup.mjs`; the build combines them with Kurviq's code. Builds of
Kurviq (like https://kurviq.com) therefore include their code, their
dependencies and Excalidraw's fonts (SIL Open Font License 1.1 and MIT).
The build lists all of them with their license texts:

- app: [kurviq.com/third-party-licenses.txt](https://kurviq.com/third-party-licenses.txt)
  (made by `npm run build:online`)
- server (Cloudflare Worker): [kurviq.com/third-party-licenses-server.txt](https://kurviq.com/third-party-licenses-server.txt)

The notices are generated from the bundles' actual contents by
[`online/licenses.mjs`](online/licenses.mjs).
