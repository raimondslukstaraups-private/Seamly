# Seamly

A small, fully in-browser tool that turns a handful of SVG motifs into a seamless, endlessly repeating pattern, ready for wallpaper or print-on-anything.

Plain HTML + JavaScript, no build step, no dependencies. Files never leave your computer.

## Run it

- **Simplest:** double-click `index.html`.
- **Or with a local server** (useful while developing):

  ```bash
  python -m http.server 8765
  ```

  then open http://localhost:8765.

## How it works

1. **Motifs:** drop SVG files in. Each one keeps its imported size. Open a motif to set its width, size %, random size, rotation, random rotation, mirroring, how often it appears (weight) and hue shift.
2. **Tile & spacing:** the tile is the unit that repeats. Motifs crossing an edge are drawn again on the opposite side, so the joins are invisible. *Min. gap* is the smallest allowed distance between any two motifs, including across edges.
3. **Scatter:** random placement with a seed (same seed = same pattern). Overlap check is either **Real shape** (uses the motifs' actual outlines) or **Circle** (faster, looser). *Fill gaps* keeps the current layout and adds more motifs in the free space.
4. **Edit by hand:** click a motif to select it, drag to move it (it wraps around the edges), `Del` removes it, `[` / `]` rotate (hold Shift for 1°), `+` / `-` resize. Motifs that are too close are outlined in red.
5. **Export:**
   - **Tile · SVG / PNG**: one repeat unit. The PNG gets DPI metadata so print software knows its physical size.
   - **Output · SVG / PNG**: the pattern repeated to the full output size. In the SVG, motifs are never cut at tile edges, so there are no hairline seams.
   - **Copy CSS background**: the tile as a repeating web background.
   - **Save / Open project**: a `.json` file with the motifs, settings and layout. The last session is also autosaved in the browser.

Print tip: 150 DPI is usual for wallpaper; 300 DPI for small objects viewed up close.

## Hosting

It's a static site, so any static host works. For GitHub Pages: push this folder to a GitHub repo, then *Settings → Pages → Deploy from branch → main / root*.

## Code map

| File | What it does |
|---|---|
| `js/motifs.js` | SVG import: cleans editor metadata, makes ids/classes unique, measures bounds |
| `js/collision.js` | Wrap-around overlap checks (shape grid + circles) |
| `js/layout.js` | Seeded random scatter |
| `js/render.js` | SVG markup for tiles and the live preview |
| `js/export.js` | SVG / PNG / CSS export |
| `js/app.js` | UI, interaction, save/restore |
