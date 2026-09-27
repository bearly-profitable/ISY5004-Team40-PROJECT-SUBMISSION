# Lumina demo video

A ~90 s launch video built from real recordings of the app, edited in code with
[Remotion](https://www.remotion.dev). Nothing in the UI shots is mocked: every
screen is headless Chrome running Lumina on `testing_images/`, with the real
backend doing the analysis.

## Pipeline

| Step | Command | What it does |
|---|---|---|
| Capture | `node capture/record.mjs` | Drives the app on `localhost:3000` with Playwright and screencasts 12 clips at 1600×900 CSS px, 2× scale (3200×1800). The page clock runs at `SLOW` (0.3) and every action is stretched to match, so the footage has ~90 fps of real frames. |
| Encode | `node capture/encode.mjs` | Resamples each clip to a constant 60 fps of page time → `public/clips/*.mp4`, plus the click/scroll log as `*.json`. |
| Preview | `npm run studio` | Remotion Studio. |
| Render | `npm run render` | `out/lumina-demo.mp4`, 1920×1080, 60 fps, H.264. |

Re-shoot some clips only: `CLIPS=world,why node capture/record.mjs`, then
`node capture/encode.mjs world why` (the clips they depend on still run, unrecorded).

The app's upload, gallery and session pages need a login. For a capture run, empty
`MEMBER_STEPS` in `frontend/components/SignInGate.tsx`, then restore it with
`git checkout -- frontend/components/SignInGate.tsx`.

## Edit

- `src/LuminaDemo.tsx`: the timeline. Each shot names a clip, the stretches of it to
  play (`segs`: clip seconds → output seconds) and a camera path (`cam`: zoom and
  focus point on the clip's clock). Click sounds come from the recorded click log.
- `src/lib/time.ts`: song landmarks (`SONG`) and beat grid, measured from the track
  with librosa. Shots start on beats.
- `src/scenes/`: the cold open, the album page carousel and the end card.

## Audio

- `audio/gen_music.py`: the soundtrack, one Lyria 3 Pro song ($0.08) through
  `tools/mascot/orclient.py`, so it is logged against the $5 cap.
- `audio/make_sfx.py`: whooshes, impacts, clicks and a sparkle, synthesised with numpy.
