# PZ Animator

A standalone animation tool for **Project Zomboid** (Build 42) modders. No Blender needed: it loads the
character models, skins and vanilla animations straight from your game folder, previews any model or
animation you drag in (players, zombies, animals), and exports animations into a mod, either replacing
a vanilla animation or adding a new AnimSet node.

> **Status:** early but usable: view, animate (posing, keyframes, interpolation) and export to mods.
> See [Roadmap](#roadmap).
>
> Unofficial fan-made tool, not affiliated with or endorsed by The Indie Stone. It contains **no game
> files**; it reads them from your own Project Zomboid install.

## Download (Windows)

1. Download the latest `PZ-Animator-x.y.z-win.zip` from [Releases](../../releases) and unzip it anywhere.
2. Run `PZ Animator.exe`. It's unsigned, so Windows SmartScreen may warn: choose **More info → Run anyway**.
3. Click **Choose Project Zomboid folder…** and pick your install folder, usually
   `C:\Program Files (x86)\Steam\steamapps\common\ProjectZomboid`. (The `media` folder itself also works.)

The folder is remembered for next time. The tool only **reads** your game files.

## Controls

| Action | Input |
|---|---|
| Orbit camera | Middle mouse drag |
| Pan | Right mouse drag |
| Zoom | Mouse wheel |
| Reset camera | F |
| Show/hide skeleton | B |
| Play / pause | Space |

In Animate mode, left mouse poses bones (see below).

## Features

- Finds `MaleBody.x` / `FemaleBody.x` and the body textures automatically.
- Female / Male, Human / Zombie, skin 01–05 (zombie 01–04), zombie rot levels 1–3.
- Lists every `.x` animation in `media/anims_X`, searchable.
- Scrub, play/pause and preview speed.
- **Keep base skeleton** (off by default; vanilla clips often move bones on purpose, e.g. planted feet): bones keep the loaded model's lengths and only rotations come
  from the animation (the root bone's hip motion and `Translation_Data` forward motion are kept). Some clips
  carry their own proportions, which in-game makes the body rise and sink as the game fades between clips.
  Export uses the same rule, so the preview matches the exported file.
- **Used by:** lists every vanilla AnimSet node that plays the current clip (main clip, part of a blend, or a
  transition), so you can see what replacing it will affect.
- **Forward speed:** shows how fast a clip moves the character. PZ moves characters by the animation's root
  motion, so a clip's stride sets walking speed.
- **Drag and drop** files onto the window:
  - `.png` / `.jpg`: used as the texture on the current model.
  - `.x` model: replaces the character (its texture is found among the dropped files, then in your game folder).
  - `.x` animation: plays on the current model. Files that contain both (most vanilla animations) ask which you want.
  - Click Female or Male to go back to the PZ body. A dropped animation keeps playing until you pick one from the list.

## Animating

Click **Animate…** and choose:
- **New animation** (from the rest pose; for the PZ bodies that's the first frame of `Bob_Idle`), **New, from the current frame** (the pose the preview shows),
  **Edit a copy** of the playing clip (every frame becomes editable keys), or **Resume** the autosaved one.

Then:

| Action | How |
|---|---|
| Rotate a bone | Drag the handle at the end of the bone (its joint). The bone points at the mouse. |
| Twist a bone | Shift + drag a handle |
| Move the hips / whole body | Drag the orange handle. With **IK hands & feet** on, the feet stay planted (easy crouches). |
| IK (hands and feet) | With **IK hands & feet** on, dragging a wrist or ankle handle moves the whole arm or leg; the elbow/knee keeps its bend direction and the hand/foot keeps its orientation. |
| Copy / paste | Select a key and Ctrl+C (or **Copy**) copies it; with no key selected it copies the current pose. Ctrl+V (or **Paste**) keys it at the current frame. |
| Loop | **Loop** keeps a live copy of the start pose after your last key, so the animation loops seamlessly even as you edit frame 0. Drag the timeline's *loop* marker to change the gap. |
| Key | Moving a bone keys it at the current frame (auto-key). **Key pose** (K) keys every bone. |
| Timeline | Click or drag to scrub, ←/→ step a frame. Click a key to select it, drag it to retime, Delete to remove. The timeline grows as you add keys; the last key is the loop point. |
| Interpolation | Select a key, then pick **In** and **Out**: Flat (hold, then snap), Linear (constant speed) or Cubic (ease). Between two keys the earlier key's Out and the later key's In apply. |
| Overall speed | Plays faster or slower; baked into the export. |
| Forward per loop | Root motion for walk-type clips (vanilla Bob_Walk: 0.945). 0 keeps it in place. |
| Reduce keys | Vanilla clips are baked with a key on every frame. **Reduce keys** removes, per bone, every key the motion can be rebuilt without, within the tolerance (default 0.5°; higher = fewer keys). The timeline highlights the selected bone's remaining keys. |
| Undo / redo | Ctrl+Z / Ctrl+Y |

Work is autosaved in the app. **Export to mod…** exports the animation you're editing, using a vanilla
clip of the same skeleton (e.g. `Bob_Walk.x`) as the template for the file's header and bone list.

## Exporting to a mod

Play an animation, then click **Export to mod…**:

- **Replace a vanilla animation:** export under the same name (e.g. `Bob_Walk`, `Cow_Idle01`). It goes to the same
  relative path as the vanilla file, so the game uses yours instead. No XML needed.
- **Add a new node based on a vanilla one:** pick a vanilla AnimSet node (e.g. `player/actions/DigHoe.xml` or
  `cow/idle/idle1.xml`). It's copied next to the original with your animation name and condition value; events
  and transitions are kept. Nodes that `x_extends` another file keep their `x_name` IDs (that's how overrides
  match the parent); stand-alone copies get fresh IDs.
- **Replace warnings:** the dialog lists every vanilla node that uses the clip, and compares forward speed
  with the vanilla clip. **Match vanilla speed** scales the forward motion so the game keeps the speeds it
  expects (a slower walk can otherwise turn sprint into an injured walk, for example).
- **Kate_ copy:** optional, off by default. The game appears to use `Bob_` clips for both sexes.
- **Target:** a new mod (creates `42/mod.info` and `common/`) or an existing one in your mods folder
  (default `<your user folder>\Zomboid\mods`). Build 42 ignores mods without a `42` folder, so for old-layout
  mods the tool adds one and copies `mod.info` into it. Existing files are never overwritten without confirming.

> **Enable animation mods from the main menu, restart Project Zomboid, then load your save.** Animations
> load at startup, so enabling a mod mid-session won't show the change. If something looks off after
> switching mods on an existing save, try a new game.

Replacing a clip affects every node that uses it. Replace is safest for one-off action clips (a reload, digging);
for anything custom, adding a new node leaves vanilla behaviour alone. Movement clips (walk, run) feed into
injury, sneaking and weapon blends.

## Running from source (any OS)

Needs Node.js 18+.

```
npm install
npm start
```

`npm run dist` builds the Windows zip into `dist/`.

Opening `src/index.html` from a local web server runs a browser "dev mode" that reads test files from
`src/testdata/` (an `index.json` list plus a mini `models_X` / `anims_X` / `textures` / `AnimSets` tree).
Copy those from your own install; game files are git-ignored and must never be committed.

## Project layout

- `main.js`: desktop shell; folder picker and read-only file access, limited to the game's media folder.
- `src/xparser.js`: reader for text-format DirectX `.x` files.
- `src/character.js`: builds the skinned character and converts `.x` animations for preview.
  Note: `.x` rotation keys are the *conjugate* of the three.js quaternion (verified against
  vanilla files). The exporter must apply the reverse (`quatToXKey`).
- `src/xwriter.js`: writes animation `.x` files (keeps a vanilla file's header and skeleton, regenerates
  the AnimationSet). Round-tripping a vanilla animation reproduces it exactly.
- `src/exporter.js` / `src/exportui.js`: builds and writes mod files; the export dialog.
- `src/refs.js`: indexes which AnimSet nodes use which clips.
- `src/editor.js`: the animation document: keys, interpolation, evaluation, baking for export.
- `src/posing.js`, `src/timeline.js`, `src/animate.js`: joint handles and dragging, the timeline, Animate mode.
- `src/app.js`: UI.

## Roadmap

- [x] Viewer: male / female / zombie, skins, rot levels, vanilla animation browser
- [x] Drag-and-drop models, textures and animations
- [x] Export to a new or existing mod (replace vanilla, or new node from a vanilla template)
- [x] Keep base skeleton, Used by panel, forward speed warnings and Match vanilla speed
- [x] Bone posing (drag a joint to rotate, Shift to twist, hip move), auto-key, timeline that grows with keys
- [x] Per-key interpolation: flat / linear / cubic, separately in and out
- [x] Overall speed and forward motion, undo/redo, autosave
- [x] Key reduction, IK for hands and feet (with planted feet), copy/paste keys, loop toggle, idle rest pose
- [ ] Save / open animation project files
- [ ] `.fbx` / `.glb` support

## AI disclosure

This project was built with [Claude](https://claude.ai), Anthropic's AI assistant. Claude wrote the code and
documentation under the direction of the project owner, who defined the features, supplied reference files
from the game for testing, and tested the results in Project Zomboid. Bug reports and contributions from
people are very welcome.

## Credits

Built with [three.js](https://threejs.org) (MIT) and [Electron](https://www.electronjs.org).
Project Zomboid is © The Indie Stone.

## License

[MIT](LICENSE)
