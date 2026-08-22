# Asset Stage — for the new workspace

## What changed on my side

My first pass targeted `3_TimrX_Frontend/TimrX--Frontend`, whose working tree is clean —
your redesign lives in `TX_Git_Repo/TimrX---3D-Print-Hub-Edits/TimrX/Frontend`, uncommitted.
Everything below is built against **that** tree.

The old approach is dead, for a concrete reason: `workspace.css:671` now says

```css
.timrx-3dprint .ws-viewer { grid-area: viewer; display: none !important; }
```

The viewer — and therefore `#viewerPlaceholder`, which v1 mounted into — does not exist on
screen until `body.ws-viewer-open`. So there is no empty state to dress up.

## What the new page actually gives us

`workspace.css:479`:

```css
.timrx-3dprint .ws-grid {
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas: "rail" ".";     /* row 2 is an unnamed, empty area */
  height: calc(100vh - var(--ws-navH));
}
```

Row 2 is genuinely empty and full-width, and everything else — control sheet
(`panel.css:53`, `position:fixed`), assets modal, command palette, tray — floats above it.

That is the whole viewport minus the dock and the command bar. So this time the thing you
originally asked for is actually possible: **one field behind the entire workspace**, not a
box inside a pane.

## How it mounts

`<div class="ws-stage">` as the first child of `.ws-grid`, placed by **grid line**:

```css
grid-area: 1 / 1 / -1 / -1;   /* not a named area */
z-index: 0;
```

Line placement, not `grid-area: stage`, on purpose — `workspace.css` keeps
`grid-template-areas: "rail" "."` **unchanged**, and the `body.ws-viewer-open` override in
`nav.css:1469` that rewrites the areas to `"rail" "viewer"` keeps working untouched.

Then it masks itself out of the chrome:

- **Vertical** (`.ws-stage`) — fades above the command bar, reading `--ws-cmdbar-zone`
  straight from `nav.css`, so resizing the bar moves the mask automatically. Clearance
  grows to `zone + 96px` only under `body.ws-model-mode.ws-intro-done` /
  `.ws-video-mode.ws-intro-done` — i.e. only when the tray is actually out.
- **Horizontal** (`.ws-stage__inner`) — soft edges left and right.
- **Dock punch-out** (`.ws-stage__field`) — a soft ellipse over the creation dock. Sized in
  **px, not %**, because the dock is `width: min(100%, 740px)`: a percentage punch is far
  too wide at 2560px and too narrow at 1100px. A flat top fade would have had to reach a
  third of the way down to clear two lines of dock type, killing the top corners for nothing.

Three masks on three nested elements rather than one element with `mask-composite`, which is
still uneven across engines.

## Behaviour

| Body state | Stage |
|---|---|
| default | full field, interactive |
| `ws-panel-open` / `ws-cmd-open` / `assets-modal-open` | `--af-dim: .26` + 3px blur, pointer-events off — recedes to ambient texture behind the sheet |
| `ws-viewer-open` | `display: none` — the viewer owns the row |
| `tutorials-view` / `community-view` / `docs-view` / `history-expanded` | `display: none` |

Clicking a card calls `TimrXInspire.loadIntoViewer()` if present (it already handles
glb / image / video), after setting `ws-viewer-open`. Otherwise it emits
`timrx:asset-stage-open` on `#wsStage` with the asset — hook your own loader there.

## Composition

- Three depth tiers — far (0.48× scale, 30% opacity, 0.9px blur), mid (0.76×, 55%),
  near (1.14×, 86%, sharp).
- Placement: over-generated jittered grid → **farthest-point sampling**. A random subset
  leaves visible dead zones; farthest-point gives an even, hole-free spread.
- Near tier is biased toward the middle of the usable band — its top and bottom are masked
  under the dock and the bar, so a big card there would only ever be a fading sliver.
- **Portrait containers** (phones): the dock stacks into one column and eats the top ~40%,
  so the field is confined to a band from 40% down, and cards are sized against that band
  rather than the full stage. Spreading over the full height there just parks cards under
  the mask.
- Palette re-skinned to your new tokens — teal `--accent-blue`, sand `--accent-purple`,
  rose `--accent-pink`, gold `--accent-neo`. The v1 lime/cyan/magenta read as a different
  product next to this shell.
- Deliberately quiet at rest: hairline borders, no glow. Contrast arrives on hover.
- **No headline.** Your design has nothing in that space and a gradient wordmark would
  fight it. The assets are the content.

## Motion

- Drift: four keyframe paths, randomised duration (8–18s) and negative delay per card.
- Pointer parallax by depth (far 0.18× → near 1.00×, max 22px). Listener lives on
  `.timrx-3dprint`, not the stage — the stage is `pointer-events: none` so it never eats a
  click meant for the dock.
- Shuffle every 6.8s: two cards fade out, take a new asset, re-jitter **within their own
  cell**, fade back in. Nothing teleports.
- Zero per-frame JS layout. The only rAF work is two custom-property writes.
- Pauses on `IntersectionObserver` exit and `visibilitychange`.
- Still collage on `prefers-reduced-motion` **or** `hardwareConcurrency <= 4`.

## Data

`localStorage['timrx_inspire_cache']` first (Inspire warms it → real assets on first paint,
no network), then `GET /api/_mod/inspire/feed?type=all&mix=balanced&shuffle=true&limit=36`,
upgraded in place. 6s timeout, `AbortController`, content-type checked before parse.
Falls back to 16 generated SVG tiles in the new palette, so it is never empty.

---

## Integration — 3 edits, none to workspace.css / nav.css / panel.css

**1. Drop in**

```
TimrX/Frontend/3dprint-modules/asset-stage.js
TimrX/Frontend/3dprint-modules/css/asset-stage.css
```

**2. `3dprint-modules/main.css`** — append after module 14:

```css
/* 15. Asset stage — the living asset field behind the workspace */
@import url('css/asset-stage.css?v=20260802a');
```

**3. `3dprint.html`** — first child of `.ws-grid` (line ~633, immediately after the
`<div class="ws-grid" …>` opening tag):

```html
    <!-- Asset stage — spans the whole grid behind the dock. Must stay the
         first child so it paints under .ws-rail and .ws-viewer. -->
    <div class="ws-stage" id="wsStage" role="region"
         aria-label="Featured creations from the TimrX community">
      <div class="ws-stage__inner">
        <div class="ws-stage__wash" aria-hidden="true"></div>
        <div class="ws-stage__field"></div>
      </div>
    </div>
```

…and the script alongside the other module scripts:

```html
<script defer src="3dprint-modules/asset-stage.js?v=20260802a"></script>
```

### Runtime API

```js
TimrXAssetStage.setDensity('calm' | 'cozy' | 'rich')
TimrXAssetStage.reshuffle()
TimrXAssetStage.setStill(true)
TimrXAssetStage.destroy()
```

---

## Verified

| Check | Result |
|---|---|
| 2600×1439 | 26 cards, dock + tray + command bar all clear |
| 1600×1000 | 26 cards, stage box 1576×894 |
| 1440×900 | 22 cards |
| 430×932 phone | 12 cards, band composition below the stacked dock |
| Console / page errors | none |
| `ws-viewer-open` → stage `display:none`, viewer `display:flex` | pass |
| `ws-panel-open` → `--af-dim: .26` + blur | pass |
| Against unmodified `grid-template-areas: "rail" "."` | pass — no workspace.css edit needed |
| Hover: lift, teal hairline, chip, caption, field recedes | pass |
| Reduced-motion → still collage | pass |
| **Real `3dprint.html` @1600×1000, full CSS chain** | 26 cards, dock + command bar clear, no JS errors |
| **Real `3dprint.html` @430×932** | 12 cards, band composition, dock + bar clear |

## Two bugs found while verifying on the real page

### 1. `.ws-corner-launcher` loses `position: fixed` — and pushes the whole workspace down 169px

`nav.css:1252` declares it `position: fixed`. But `variables.css:177`:

```css
body.print3d-page > *:not(.workspace-modal-overlay) { position: relative; z-index: 2; }
```

is `(0,2,1)` and beats `(0,1,0)`. You already wrote `html body.print3d-page > …` restores for
`.cc-banner`, `.ws-cmd-trigger`, `.ws-tray` and `.ws-cmd` — `.ws-corner-launcher` was missed.

Measured on the rendered page at 1600×1000:

```
DIV.ws-corner-launcher  pos=relative  y=-22  h=169     ← in normal flow
SECTION.timrx-3dprint   pos=relative  y=169  h=1000    ← pushed down 169px
.ws-grid                y=239  h=930                   ← bottom at 1169, viewport is 1000
```

So the workspace overflows the viewport by 169px, and the creation dock sits ~169px lower
than intended. Your own screenshot shows the symptom. Fix — one block next to the others:

```css
html body.print3d-page > .ws-corner-launcher {
  position: fixed;
  z-index: 120;
}
```

I did **not** apply this — it is your bug, not mine, and it changes the whole page's vertical
rhythm. The stage compensates for it either way (see `--af-overflow` below), so it will look
correct before and after you fix it.

### 2. `.ws-grid` becomes `display: flex` below 1280px

`media/workspace-media.css:11` switches the grid to `display:flex; flex-direction:column;
height:auto` and unlocks page scroll. Grid-line placement is meaningless in flex, so the
stage collapsed to **zero height** on mobile — 0 cards. Fixed in `asset-stage.css`: below
1280px the stage becomes `position: fixed; inset: var(--ws-navH) 0 0 0`. It is a background
field, so being pinned under the scrolling column is the right behaviour anyway.

## Two things I'd flag

0. **`--af-overflow`.** `.ws-grid` is `height: calc(100vh - var(--ws-navH))`, which is only
   correct while the workspace starts at exactly `--ws-navH`. Bug 1 breaks that assumption,
   and any future body-level element in flow would too. So the JS measures the real overflow
   past the viewport bottom each build and feeds it into the bottom mask stops. Without it,
   cards render behind the command bar.

1. **`--ws-cmdbar-h` responsive steps.** `nav.css` drops it to 66 / 58 / 54 / 48px at
   1180 / 820 / 640 / 480px. The mask reads `--ws-cmdbar-zone`, so it follows — but if you
   change those breakpoints, check the bottom fade at each one.

2. **Cost next to Three.js.** The stage runs no WebGL and no per-frame JS, but it does hold
   ~26 composited layers. It hides itself entirely under `ws-viewer-open`, so it never runs
   alongside a live model. If you ever show the viewer *and* the stage together, drop
   density to `'calm'` first.
