# AI Makeup Assistant

Real-time AR makeup mirror. Opens the webcam, tracks the face with MediaPipe
Face Landmarker, and (eventually) overlays step-by-step makeup placement guides
derived from tutorial data.

This is the **initialization MVP**: it proves the camera + tracking loop works by
drawing a debug bounding box and test dots over the eyes. The JSON-driven makeup
renderer is not implemented yet.

## Stack

- **React + Vite + TypeScript**
- **Tailwind CSS** for UI
- **Zustand** for state (step, products, camera/UI status)
- **@mediapipe/tasks-vision** (Face Landmarker, 478 landmarks) for tracking
- **Canvas 2D** overlay above a CSS-mirrored `<video>`

## Prerequisites

Node.js 18+ and npm. (Node was not detected on this machine — install it from
[nodejs.org](https://nodejs.org) or via `nvm`/`brew` before running the commands
below.)

## Getting started

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` URL and allow camera access. `localhost`
is treated as a secure context, so `getUserMedia` works without HTTPS in dev.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — typecheck + production build
- `npm run typecheck` — types only
- `npm run preview` — serve the production build

## Project structure

```
src/
  components/
    CameraMirror.tsx   # webcam + MediaPipe loop + canvas overlay (core)
    ControlBar.tsx     # massive Next/Back controls
    TrackingHud.tsx    # top status pill (permission / tracking / face presence)
  lib/
    faceLandmarker.ts  # FaceLandmarker factory (CDN model + wasm)
    landmarkIndices.ts # curated landmark indices for the placeholder overlay
  store/
    useMakeupStore.ts  # Zustand store (steps, map, camera status)
  types/
    makeup.ts          # MakeupMap JSON data contract (parser not built yet)
  App.tsx
  main.tsx
  index.css
```

## Architecture notes

- **Per-frame landmark data never enters React state.** It lives in refs inside
  the render loop and is read directly by the canvas draw call. Only a coarse
  `faceDetected` boolean is mirrored into the store, and only on transitions.
- **Mirroring** is applied once via a CSS `scaleX(-1)` on the shared parent of the
  video and canvas, so overlays stay aligned with the mirrored feed.
- Detection only runs when a fresh video frame is available
  (`video.currentTime` change), avoiding redundant inference.
