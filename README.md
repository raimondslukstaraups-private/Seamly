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

1. **Motifs:** drop SVG, PNG, JPG or WebP files in.
   - **Size:** each motif keeps its imported size. A PNG's DPI is read from the file, so a 300 DPI image comes in at its real print size.
   - **PNG and other pictures:** transparent margins are trimmed off. A picture without transparency is treated as a rectangle.
   - **All motifs size %:** resizes every motif together. On a hand-edited layout, motifs are resized where they are.
   - **Per motif:** open a motif to set its width, size %, random size, rotation, random rotation, mirroring, how often it appears (weight) and hue shift.
2. **Tile & spacing:**
   - **The tile** is the unit that repeats. Motifs crossing an edge are drawn again on the opposite side, so the joins are invisible.
   - **Min. gap** is the smallest allowed distance between any two motifs, including across edges.
   - **Keep motifs inside the tile** stops any motif from being cut at the tile edges. Use it when each tile is printed on its own. In a brick grid, the grid is moved so as few motifs as possible touch an edge, and those that still would are left out.
3. **Layout:** pick one of three modes. The seed makes results repeatable (same seed = same pattern). Overlap check is either **Real shape** (uses the motifs' actual outlines) or **Circle** (faster, looser). *Fill gaps* keeps the current layout and adds random motifs in the free space.
   - **Random:** scatter until the tile is full (or up to *Max motifs*).
   - **Brick grid:** columns × rows per tile, every row shifted by ½, ⅓ or ¼ step, at any **angle** (e.g. 45° for diagonal). The grid is nudged slightly so it always repeats seamlessly. Motifs can be sized to fit the grid, tilted with it, placed randomly or in sequence, and given a random offset.
   - **Template:** import a Seamly template, an SVG with placeholder shapes, or a picture of a pattern (PNG/JPG). Each separate shape becomes a spot, measured for position, size and angle. The biggest spots get the biggest motifs, and weights decide how many spots each motif gets. Shapes cut by the tile edge are joined back into one spot. See the `Template examples` folder.
     - **Seamly templates** (made with *Export → Template · SVG* or *Use current layout as template*) are read exactly, with no detection needed. Each motif type has its own colour, and spots of the same colour get the same motif. A motif that's still loaded gets its own spots back, and new motifs are matched by size. The tile size is restored too.
     - **Editing in another program:** you can still move, resize or recolour the shapes in Inkscape or Illustrator, and Seamly reads them as they are.
     - **Shapes:** *Ellipses* keep each motif's proportions and angle, *Circles* are simpler, and *Silhouettes* show the motifs' real outlines.
4. **Edit by hand:** click a motif to select it.
   - **Select several:** `Ctrl+click` (or `Shift+click`) adds a motif to the selection or takes it out, and `Ctrl+A` selects all. `Esc` clears the selection. Every selected motif shows its own handles. Dragging a motif moves them all together, and turning or resizing one with its handles turns or resizes all of them by the same amount, each around its own centre. Delete, copy/cut/paste/duplicate and the keyboard shortcuts work on every selected motif.
   - **Move:** drag the motif. It wraps around the edges.
   - **Resize:** drag a corner handle.
   - **Rotate:** drag the round handle. Hold Shift for 15° steps.
   - **Keyboard:** `Del` removes, `[` / `]` rotate (hold Shift for 1°), `+` / `-` resize.
   - **Copy and paste:** `Ctrl+C` copies the selected motif, `Ctrl+X` cuts it and `Ctrl+V` pastes it. The copy keeps its size, rotation, mirroring and colour. It's pasted under the mouse pointer when the pointer is over the preview; otherwise each paste is placed a little further from the original. `Ctrl+D` duplicates the selected motif next to itself.
   - Motifs that are too close are outlined in red.
   - **Undo / redo:** `Ctrl+Z` undoes the last change; `Ctrl+Y` or `Ctrl+Shift+Z` redoes it. The Undo and Redo buttons in the toolbar do the same. This covers layout edits, Generate, Clear, settings, and adding or removing motifs.
5. **Export:**
   - **Tile · SVG / PNG**: one repeat unit. The PNG gets DPI metadata so print software knows its physical size.
   - **Output · SVG / PNG**: the pattern repeated to the full output size. In the SVG, motifs are never cut at tile edges, so there are no hairline seams.
   - **Template · SVG**: the layout with every motif replaced by a coloured placeholder shape, to reuse later with other motifs.
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
| `js/layout.js` | Seeded random scatter, seamless brick grid, template placement |
| `js/template.js` | Template import and spot detection |
| `js/render.js` | SVG markup for tiles and the live preview |
| `js/export.js` | SVG / PNG / CSS export |
| `js/app.js` | UI, interaction, save/restore |
