# Fresh-CAN reference images

Drop the real reference photos of the Fresh-CAN truck/container here before
uploading them (nothing in this folder is read directly at runtime — the
app only ever uses the public URLs pasted into
`src/server/pipeline/prompts/brand/fresh-can.ts`, since Flux Kontext needs a
URL it can fetch itself, not a local file).

All three exterior angles are uploaded (2026-09-10) to the public
`brand-assets` Supabase bucket and wired into
`src/server/pipeline/prompts/brand/fresh-can.ts`'s `referenceImages.exterior`
array, each paired with `framing` text describing what that specific photo
shows:
- `truck_exterior_back.png` — the true rear-entrance shot (the door, header
  bar wordmark) matching what `containerDescriptor` describes.
- `truck_exterior_arrival.png` — a three-quarter front view of the truck
  arriving/parked at the curb.
- `truck_exterior_standing.png` — a full side-profile view.

`composeHeroPrompt`/`composeInlinePrompt`/`composePhotoPrompt` each pick one
of the three independently (deterministically, so retries are stable) —
see `core/rotation.ts` and `core/compose.ts`.

`freshcan_interior_1.png` / `freshcan_interior_2.png` aren't used — no
current prompt builds an interior scene, so there's nothing for them to
guide. Keep them here for when an interior-scene prompt template exists.

## Adding another reference photo later

1. Put the new image file in this folder.
2. From the repo root, run:
   ```bash
   npm run upload-brand-asset -- assets/fresh-can/<filename>
   ```
   This uploads it to the `brand-assets` bucket (created once already for
   this project) and prints back its public URL.
3. Add a new entry to `referenceImages.exterior` in
   `src/server/pipeline/prompts/brand/fresh-can.ts`, with a `framing` string
   that accurately describes what the new photo actually shows —
   mismatched framing/photo pairs confuse Flux Kontext's image-editing mode.

Re-running the upload command with an existing filename overwrites that
object at the same URL (upsert), so replacing a photo with a corrected
version never requires editing the brand file again.
