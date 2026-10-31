# Background Studio

A free, private app for removing image backgrounds in bulk, running entirely on your Mac.
Drop in photos or whole folders. It saves transparent PNGs (and, if you like, copies on white, black
or any colour) to a separate folder. Your originals are never modified.

* Runs 100% locally with open-source models via [rembg](https://github.com/danielgatis/rembg). No
  accounts, no uploads, no analytics.
* Works offline after a one-time setup.
* Handles hundreds of images: progress bar, live counts, cancel/resume, retry failed.
* Before/after editor with a comparison slider, zoom, sliders, crop & straighten, and keep/erase brushes.
* Re-running a batch skips images that were already done.
* Download everything as one ZIP.

**Try it in your browser first:** the [lite demo](https://jkw2lo.github.io/background_studio/) runs the
same interface on 7 sample pictures. Their AI outlines were made in advance by the real models, and
everything after that (methods, edges, ink, crop, tone and touch-ups) runs live in the page. It never
reads your own files. How it's built: [lite/](lite/) (`python3 lite/build.py` makes the site;
`lite/tools/make_demo.py` remakes the sample outlines).

---

## Start here (Mac)

**One-time setup** (needs internet, about 2 minutes, about 850 MB on disk):

1. Put this folder somewhere permanent, for example `~/Applications/Background Studio`.
2. Open **Terminal**, type `cd ` (with a space), drag the folder onto the Terminal window, press Return, then run:

   ```bash
   ./setup.sh
   ```

   It lists exactly what it will download and asks before starting. It finishes with an offline
   self-test.

**Every time after that** (no internet needed):

* Click **`Background Studio.app`** (in this folder). **Drag it to your Dock** once and it's a
  single click from then on. It starts the app quietly in the background, with no Terminal window,
  and opens it in your browser. Click it again while the app is running and it just brings the page
  back, rather than starting a second copy.
* To stop it, click **Quit** in the app.
* Prefer to see what it's doing? Double-click **`Background Studio.command`** instead; it runs in a
  Terminal window (close the window to stop). Background runs log to `data/server.log`.
* If you move this folder, run `./make-launcher.sh` once to rebuild the app.

> If macOS says the app or the `.command` file "can't be opened", right-click it, choose **Open**, then **Open**
> again. This only happens if the folder was downloaded or copied from another Mac.

### Files & Folders permission

The first time you add images from Desktop, Documents, Downloads or Pictures (or save results to
Pictures), macOS asks whether **Terminal** may access that folder. Click **Allow**. This is
macOS's standard privacy prompt, so the app can read the images you chose. You can review it later in
*System Settings → Privacy & Security → Files and Folders*.

---

## Using it

Both tabs work in steps, shown along the top. **Next** unlocks once a step is done, and you can click
back to any earlier step at any time.

1. **Add images.** Drop files or folders anywhere on the window, or use **Choose a folder… /
   Choose files…**. Folders are searched recursively. Supported: JPG, PNG, HEIC/HEIF (iPhone), WebP,
   TIFF, BMP. Hidden files and non-images are ignored.
2. **Settings.**
   * **What are you cutting out?** This matters most; see [Scans vs photos](#scans-vs-photos).
   * **Save results to:** defaults to `~/Pictures/Background Studio Output`. It must be a different
     folder from your originals; the app refuses to save inside a folder it's reading from.
   * **Background:** *None* saves transparent PNGs. *White / Black / Custom* **also** saves a copy
     on that colour in a subfolder (`on-white/`, `on-black/`, `on-ff8800/`…). Switching colours
     later re-uses the existing cutouts, so it's nearly instant.
   * **Model:** see below.
   * **Skip images already processed** (on by default).
   * **Clean up edge colour fringing:** removes coloured halos around hair and soft edges. Slower.
   * **Trim empty space around cut-outs** (on by default): crops each transparent result to the item
     plus a small margin, so stickers don't sit on a huge empty canvas.
   Then click **Remove backgrounds**. It goes straight to step 3.
3. **Results.** Progress is shown at the top, with **Cancel**. Cancelling lets the image in progress
   finish and leaves the rest queued; start again from step 2 to resume.
   **Review and fine-tune** here. Click any thumbnail to open the editor: drag the slider to compare,
   switch the backdrop to spot halos, zoom 2×/4×, use ← → to step through, and adjust anything that
   isn't right (see [Fine-tuning an image](#fine-tuning-an-image-the-editor)). Failed images show the reason and
   a **Retry** button. The summary card has **Retry failed**, **Open output folder** and
   **Download all as ZIP**, plus **Sort & tag the results →**.

### Scans vs photos

AI background-removal models are trained on *photos*: they look for the main subject in a scene. A
scanned ticket, postcard or stamp has no "subject" in that sense, so the AI cuts the printed artwork
apart. Pick the image type that matches your images:

| Image type | What it does | Good for |
|---|---|---|
| **Auto-detect (scanned items)** (default) | Looks at the scan's edges and picks one of the methods below for each image | A mixed folder of scans |
| **Cut-out items** | AI finds the item's outline, then the outline is **filled solid** so nothing printed on the item can be removed | Die-cut stickers, labels, tags, coasters on a table or scanner bed |
| **Ink on paper** | Makes the paper colour transparent and keeps the ink, with its true colour recovered from faint or thin strokes (no AI) | Rubber stamps, calligraphy, sketches, receipts, logos on white |
| **Photos** | Classic AI subject cut-out | People, products and objects in photos |

How Auto decides:
* **Blank white around the item** (your scanning app already whited out the surroundings): *ink on paper*.
* **A plain, even surface around the item:** *cut-out item*.
* **The item fills the scan** (edges of many different colours, e.g. a postcard scanned edge to edge): there is no
  background to remove, so it's **kept as is** (saved as a PNG, unchanged) rather than damaged.

If Auto picks the wrong method for an image, or the result is nearly but not quite right, click the
image to open the editor (below).

### Fine-tuning an image (the editor)

Click any finished image. The right-hand panel changes the result with a live preview; nothing is
written until you click **Save**, which re-renders that image at full size.

* **Method**: Auto, Cut-out item, Ink only, Photo, Card (keep the whole card, trimmed and
  straightened) or Keep as is.
* **Ink** (ink-only images): *Ink strength* makes faint stamps bolder or removes more paper
  texture. *Paper colour → Pick…* lets you click on bare paper if the paper is tinted or uneven.
* **Edges** (cut-out items and photos): *Edge* shrinks the outline to remove a leftover rim of
  background, or grows it to keep more. *Softness* feathers the edge. *Fill holes* keeps everything
  inside the outline. *Clean up edge colour fringing* removes background colour bleeding into soft
  edges.
* **Rotate & straighten**: *⟲ / ⟳ 90°* turn sideways scans upright. *Straighten* rotates by
  fractions of a degree (a grid appears while you drag), and *Auto-straighten* levels the image's
  lines and edges for you. Empty corners from straightening are cropped away automatically for
  cards, ink and kept images.
* **Crop**: *Adjust corners…* shows the (rotated) image with four handles and a grid with thirds.
  With *Keep 90° corners* on (the default) the crop stays a true rectangle; turn it off to drag
  each corner freely, which also corrects perspective on a card photographed at an angle.
  *Auto-detect* finds scanner edges, and *No crop* turns automatic trimming off for that image.
* **Tone**: *Brightness*, *Contrast* and *Saturation*, plus *Auto levels* for dull or faded scans.
  Tone is applied to the finished result; the "Before" side always shows the untouched original.
* **Touch up**: *Keep brush* paints parts of the original back in; *Erase brush* removes anything
  left over. The faint image underneath shows what was removed.
* **Grid** (top bar, or **G**): straight-line guides over the image at any time.
* **Zoom & pan**: pinch on the trackpad (or ⌘/Ctrl + scroll wheel) to zoom towards the pointer, up
  to 8×; scroll with two fingers, hold **Space** and drag, or drag with the middle mouse button to
  move around. **Double-click** jumps between Fit and 2.5× at that spot; **⌘+ / ⌘− / ⌘0** zoom in,
  out and back to Fit. Panning with Space works with any tool, so you can move around mid-touch-up
  without painting.
* **Copy settings / Paste**: copy one image's method, rotation, tone, ink and edge settings and
  paste them onto the next similar image (crops aren't copied; they belong to one image).
* **Save & next →** (**⌘↩**) saves and opens the next image, so you can review a whole folder
  without closing the editor. Saving while a batch is running is fine: the image joins the queue.
* **Reset** forgets the image's manual changes and processes it automatically again.

Keyboard: **← →** previous/next · **Space**-drag pan · **⌘+ / ⌘− / ⌘0** zoom · **⌘S** save · **⌘↩** save & next · **R / ⇧R** rotate · **G** grid · **K / E / V** keep brush / erase brush / compare · **[ ]** brush size · **⌘Z** undo · **⌘⇧C / ⌘⇧V** copy / paste settings · **Esc** close.

Manual changes are saved with the results (in a hidden `.background-studio` folder inside the
output folder), so they survive restarts and reruns: the image is skipped, or redone with your
settings if the original changes.

For cut-out items, **BiRefNet Lite** gives clearly cleaner outlines than IS-Net (worth the extra time).

### What gets saved where

```
Background Studio Output/
├── Products/                  ← same folder structure and file names as your originals
│   ├── shoe-01.png            ← transparent PNG (always)
│   └── shoe-02.png
├── on-white/Products/…        ← only if you chose a White background
├── .background-studio.json    ← record of what the app made (used for skipping)
└── .background-studio/        ← cached AI outlines and your touch-up edits (safe to delete;
                                 deleting it loses brush touch-ups)
```

* File names are kept; only the extension becomes `.png`. If two inputs would produce the same name
  (`photo.jpg` and `photo.png` side by side), the second becomes `photo_png.png`.
* Photos are rotated upright using their EXIF orientation, full resolution is kept, and colour
  profiles are preserved.
* **Skipping:** an image is skipped when its result already exists *and* the original's contents
  (SHA-256), the image type, the model and the edge setting are unchanged. Edit a photo or switch
  image type or model and it is reprocessed.
* **Safety:** originals are only opened for reading. The app only ever overwrites files it created
  itself (listed in `.background-studio.json`). If an unrelated file with the same name is already in
  the output folder, that image is marked failed and the file is left untouched. Files are written to
  a temporary name first and then renamed, so an interruption never leaves a half-written image.
* **Dragged-in files** are browser uploads to the app running on your Mac (never over the
  internet). The app keeps a temporary copy in `data/inbox/`, which is cleared when you click
  **Clear list** or restart the app. Files added with *Choose files / Choose a folder* are read
  in place, with no copies.

---

## Sort & tag

The **Sort & tag** tab (top of the window) is for quickly filing a folder of pictures into your
own categories.

It works in four steps:

1. **Images.** Click **Choose a folder…** (subfolders are included), or one of the **recent
   folders**: the background-removal results folder, folders you added there, and folders you've
   sorted before. **In this list** shows each folder with an **×** to take it off the list (files and
   tags are kept), plus **Clear all**.
2. **Categories.** Type them one at a time, or several at once separated by commas
   (`Stickers, Stamps, Tickets`). Reorder with the arrows, rename by clicking the name, and recolour
   by clicking the dot. **Save these as a set…** keeps a named set to reuse (for example
   *Souvenirs*). **Use this set** switches to it later, and categories with the same name keep
   their tags. Auto-suggest is switched on here.
3. **Sort.** One picture at a time, with your categories in a column on the right. Click one, or
   press its key (**1**–**0**, then **Q**–**P**, **A**–**L**, **Z**–**M**), and the next picture appears
   straight away.
4. **Use your tags.** Copy into folders, spreadsheet, or Finder tags (below). **Finished? Start
   again** at the bottom offers *Start a new batch* (clears the list; tags are remembered),
   *Sort these again from scratch* (removes their tags in every round) and *Go through them again*
   (keeps tags, steps through each).

**Rounds.** You can sort the same pictures up to three times, each by something different. For
example, round 1 by *place / trip*, round 2 by *content*, and round 3 a *star rating*.
* **Setting them up:** in step 2, **+ Add a round** adds another set of categories, and
  **+ Star rating** adds a 1–5 ★ round (keys 1–5). Rename a round in *Round name*, and reorder with
  *Earlier / Later*.
* **Sorting:** in step 3 the switch at the top picks which round you're sorting, with progress for
  each. Tags from other rounds show faded under the picture, so you can see *Okinawa* while picking
  *Ticket*. When a round is finished, the screen shows every round's progress, with **Next round →**
  to carry on (or *Start / Continue* beside any round). Going to the Sort step always starts at the
  first round that isn't finished yet.
* **Per round:** auto-suggest, auto-tag, *Go through all again*, *Untag all* and saved sets all
  work on the round you're in. Ratings can't be guessed, so auto-suggest is off in the rating round.
* **Exports:** the spreadsheet gets a column per round. **Copy into category folders** can use one
  round or nest them (*Folders by: Place › Content* gives `Okinawa/Ticket/…`). Finder tags include
  every round's tags.

| Key | Does |
|-----|------|
| ↩ | Accept the auto-suggested category (when Auto-suggest is on), or keep an auto-tag |
| 1–0, then Q–P, A–L, Z–M | Tag with that category and move on. Keys follow your category order along the keyboard, so up to 36 categories each have a key |
| ⇧ + the key (or shift-click) | Add that category as an extra tag and stay on this picture; press ↩ to move on |
| Space | Skip for now (skipped pictures are offered again at the end) |
| ← / → | Back and forward through the pictures you've seen, like a browser. After going back, → (or tagging) steps forward one picture at a time until you're back where you were. → on a picture that still needs a tag skips it |
| ⌫ Backspace or ⌘Z | Undo |
| `\` (backslash) | Change the background behind the picture: checkerboard, white or black (handy for transparent PNGs) |
| Click the picture, or + | Zoom in 3× at that spot, sharp at full resolution. Drag to look around; click again, −, or Esc to fit |
| / | Search your pictures |

**Auto-suggest** (tick it under Categories) guesses a category for each picture. The guess is
highlighted with how sure it is. Press **↩** to accept it, or another category's key to pick that instead. It starts
out using your category names, so plain names like *Stamp*, *Ticket* and *Postcard* work best at
first. After that it learns from every picture you tag, which is how personal categories like
*Japan trip* start working after you've tagged a handful. It runs a small image-recognition model
(CLIP) on this Mac. The first time you turn it on for a folder it spends about 0.1 s per picture
getting to know them (about 20 s for 200), then remembers them in `data/tag-fingerprints.npz`.

**Auto-tag the confident ones.** With Auto-suggest on, *Tag every picture it's at least 90% sure
about → Auto-tag…* (95/90/80/70%) shows how many it would tag in each category, then tags them in
one go. They're marked **AUTO** and don't teach the model anything until you've checked them, so one
wrong guess can't snowball. Review → **Auto-tagged, to check** lists them. **Check them one by one**
steps through them: ↩ keeps a tag, a category's key changes it, Esc stops. **Mark all as checked** keeps the
lot. Backspace (or ⌘Z) undoes the whole auto-tag.

**Duplicates.** Near-identical copies, like the same scan in two folders or a cut-out next to its
original, are found automatically. When you tag one, its copies get the same tag, so you only see
it once. *“+ 1 duplicate, tagged together”* shows under the picture. Review → **Duplicates** shows
the groups side by side. Pictures that only look alike, like two different fortune slips, aren't
counted as duplicates: it checks both overall similarity and the exact pixel pattern.

**Search.** Type a description in Review (or press **/**): *temple*, *something pink*, *QR code*,
*milk tea*. Best matches come first. It searches what's *in* the pictures, not file names. **Sort
these one by one** steps through the results like the normal sorter.

**Folders are remembered.** The folders you add are listed under Images. Each time you open the
tab it picks up new pictures added to them since last time, and drops ones that were moved or
deleted. **Check for new images** does the same on demand. Set **Sorted copies go to** once and
**Copy into category folders** uses it every time.

**Hold to keep going.** Hold a category's key (or press and hold its button) and it tags this
picture, then each next one, about two a second. Every picture is on screen for a moment before
it's tagged, so you can let go when something different comes up. A quick tap tags just one.

Keys never tag a picture you haven't seen: until the next picture has appeared, presses are
ignored. The suggestion appears on the picture itself, bottom centre. The pop-up showing the
category you just picked can be turned off under the category buttons.

**Review** shows everything as a grid, filtered by category. Click a picture to change its tag. When
you filter by a category, **Remove backgrounds for these** sends those pictures to the other tab.
**Untag all…** (in Review) starts over.

**Going through again.** When everything is sorted, **Go through all again** steps through every
picture with its current tag: ↩ keeps it, a category's key changes it. In Review, **Go through these one by
one** does the same for whatever is showing: one category, untagged pictures, duplicates or search
results.

Tags are saved as you go in `data/tagger.json`, keyed by each file's location. If you quit and come
back, or add the same folder again later, you carry on where you left off. To use your tags:

* **Download spreadsheet (CSV):** one row per picture, with a column for each category. Opens in
  Numbers or Excel.
* **Copy into category folders:** pictures are *copied* (never moved) into the **Sorted copies go
  to** folder (asked for the first time only), one folder per category. Nothing in the
  destination is ever replaced. Re-running only copies what's new. A picture with two tags is copied into both folders.
* **Add as Finder tags…:** adds your category names as macOS Finder tags on the original files, so
  you can find them in Finder's sidebar and in Spotlight. This changes only the files' tag labels,
  never the pictures. **Remove these Finder tags** takes them off again and leaves any other tags alone.

Drag-and-drop doesn't work on this tab, because browsers don't tell the app where a dropped file
lives, and tags need the real file. Use **Choose a folder…** or a recent folder.

---

## Compare & merge

The **Compare & merge** tab finds what's the same and what's different across two or more folders,
such as a folder and its backup, or folders of similar pictures, and can consolidate them.

1. **Folders.** **Add folders…** (hold ⌘ to pick several). The first one (**A**) is the main
   folder: where there are copies, its file names and layout win. Reorder with the arrows.
2. **Differences.** A Venn diagram shows which folders each file is in: one circle per folder,
   with a count and a few thumbnails in every region (only in A, in A and B, in all three…).
   Click a region to list what's in it. For overlaps, the chips narrow it to exact duplicates,
   same picture or versions. Name clashes have their own link under the diagram. With four or
   more folders, each combination is shown as a row instead. Every file is put in one of these:

   | Group | Meaning | Kept by default |
   |-------|---------|-----------------|
   | **Exact duplicates** | Byte-for-byte the same file (any type, pictures or not) | One copy |
   | **Same picture, different file** | Looks identical, but re-saved, resized or converted | The best one (most pixels, then largest, then newest) |
   | **Versions** | Same subject, edited: cropped, cut out, rotated, recoloured | All of them |
   | **Same name, different picture** | Would collide when merged | Both (the second gets “(2)”) |
   | **Only in A / B / …** | Unique files | Always |

   Tick or untick **Keep** on any of them, and **Compare side by side** to see them large, with what
   differs in bold. If a version also exists as a smaller re-export, only the better one is ticked.
3. **Consolidate.** Choose each time:
   * **Create a new merged folder:** copies one of everything into a new folder (named
     *Merged <date>*). The folders you compared aren't changed at all.
   * **Merge into folder A:** copies whatever A is missing into it, never replacing anything
     already there. Afterwards, **Move leftover copies to the Trash** clears out the other folders
     and any extra copies in A. Everything goes to the Trash, so it can be put back until you empty it.

Pictures are compared with the same local picture fingerprints as Sort & tag (and share their
cache), so folders you've sorted are compared quickly. 400 files took about 15 seconds in testing.
Other files are matched only when they're exact copies.

---

## Models

| Model | Download | Speed per photo (Apple Silicon, CPU) | Best for |
|-------|----------|-------------------------|----------|
| **IS-Net General** (default) | 179 MB | **~1.3 s** (measured) | Products and objects on clear backgrounds. Fast. |
| BiRefNet Lite | 224 MB | **~6.7 s** (measured) | Noticeably cleaner edges, ears and whiskers, and no "ghost" haze on tight crops |
| BiRefNet (best quality) | 973 MB | likely 20 s+ (not measured) | Hair, fur and intricate edges, when quality matters most |
| U²-Net (classic) | 176 MB | ~1 s (not measured) | The original rembg model |

*Tip:* run a big batch with IS-Net, filter to the images you're not happy with, and redo just those
folders with BiRefNet Lite. Switching models reprocesses images automatically (results from the
previous model are replaced).

Add a model (needs internet once), then pick it in the app:

```bash
./setup.sh --model birefnet-general-lite
```

(`--all-models` installs all four.) Models not installed appear greyed out in the menu. All four are
openly licensed (Apache-2.0 / MIT). rembg's newer default, `bria-rmbg`, is *not* included because its
licence forbids commercial use. Its cloud backends are excluded because they upload images.

---

## Privacy

* The app server listens on `127.0.0.1` only, so nothing else on your network can reach it.
* No accounts, analytics, telemetry, crash reports, update checks, CDNs or web fonts.
* A built-in network guard blocks any outbound connection from the app; the green badge in the
  top bar shows how many were blocked (always 0 in testing).
* Internet is only used by `setup.sh`. **[NETWORK.md](NETWORK.md)** lists every download, where it
  comes from and how it's verified, plus how to check it yourself.

---

## Troubleshooting

| Problem | Fix |
|--------|-----|
| "macOS did not allow access…" on some images | Allow Terminal in *System Settings → Privacy & Security → Files and Folders* (or *Full Disk Access*), then click **Retry failed**. |
| Browser didn't open | Go to `http://127.0.0.1:8765` yourself. If that port was busy, the Terminal window shows the port that was used instead. |
| The file dialog didn't appear | It may have opened behind the browser; check the Dock. On Remove backgrounds you can also drag and drop. |
| "This image file is incomplete or damaged" | The file is corrupt. Re-export it and retry. |
| Want to redo everything (for example after switching models) | Switching models already triggers reprocessing. To force it, untick **Skip images already processed**. |
| Start over completely | Quit, then delete `data/` (settings, saved tags and temporary copies). Re-run `./setup.sh` if `.venv` is damaged. |

Command-line options: `./start.sh --port 9000 --no-browser`.

Only run one copy of the app at a time. Starting it again while it's running opens a second copy on
the next port (8766, 8767…). Click **Quit** in each browser tab, or close their Terminal windows.

## Uninstall

Delete this folder. Everything (Python, libraries, models, settings) lives inside it. Your results
folder is separate; keep or delete it as you like.

---

## How it's built

**Architecture:** a small local Python web server plus a single-page UI in your browser. This
was chosen as the simplest reliable option: no app bundle or code signing, real drag-and-drop for
folders, and nothing to compile. The batch runs one image at a time on a background thread
(ONNX Runtime already uses all CPU cores for each image), so memory stays flat across hundreds of
images.

```
setup.sh                 one-time install (the only step that uses the internet)
start.sh                 starts the app (offline)
make-launcher.sh         builds Background Studio.app (one-click launcher; setup runs it)
launcher/AppIcon.icns    the launcher's icon
Background Studio.command  double-click launcher (runs setup the first time if needed)
requirements.in / .lock  top-level deps / fully pinned + hashed lockfile
app/server.py            Flask server: localhost-only, token + Host checks, CSP, native dialogs
app/compare.py           Compare & merge: duplicates, same pictures, versions, consolidation
app/tagger.py            Sort & tag: categories, tags, CSV / copy-into-folders / Finder tag exports
app/autotag.py           Sort & tag: local CLIP model, tokenizer, suggestion scoring, duplicate hashes
app/studio.py            batch queue, worker thread, output naming, manifest, skip and safety rules
app/engine.py            image loading (EXIF, HEIC, CMYK, 16-bit), cutout, compositing, atomic saves
app/models.py            local-model allowlist, offline-only model loading, setup downloads
app/netguard.py          blocks non-loopback network access inside the app
app/selftest.py          offline self-test run by setup.sh
app/static/              the UI (plain HTML/CSS/JS, no build step, no external assets)
models/                  downloaded model weights
data/                    settings, tags (tagger.json) + temporary copies of dragged-in files
```

**Tested on this Mac (Apple Silicon, macOS 26):** 253 images in one session (a 240-image folder plus
13 edge cases: HEIC, CMYK, 16-bit TIFF, 36 MP, EXIF-rotated, transparent PNG, Unicode names, name
collisions, a corrupt file). There was 1 expected failure (the corrupt file), cancel/resume worked,
reruns skipped finished images in about 0.1 s each, and the network guard recorded 0 attempted
connections.

**Ideas for later:** Apple Neural Engine acceleration through ONNX Runtime's CoreML provider. It was
4.6× faster with IS-Net in a quick test, but it hung for over 15 minutes compiling BiRefNet and calls
into macOS's analytics framework, so the app deliberately runs on the CPU only. Other ideas: a brush
to touch up masks; JPEG/WebP output for coloured backgrounds; padding and centring products on a
fixed canvas.

Built on rembg (MIT), ONNX Runtime (MIT), Pillow (MIT-CMU), Flask (BSD-3), pillow-heif (BSD-3).
Models: IS-Net / DIS (Apache-2.0), BiRefNet (MIT), U²-Net (Apache-2.0), CLIP for auto-suggest (MIT).
