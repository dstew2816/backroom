# Backroom: project context and handoff

Read this first. It holds the goals, the rules, the current state and the next steps, so a new session can carry on without the earlier conversation. Last updated 2026-11-16.

## What Backroom is

A search box for a Dungeon Master's own ideas. David writes ideas down however they come. Mid-session, when players do something unplanned or he needs filler, he types a few words and Backroom shows the ideas he already wrote that fit, best match first.

- Live demo: https://dstew2816.github.io/backroom/
- Repository: https://github.com/dstew2816/backroom
- Portfolio page (separate repository): https://dstew2816.github.io/projects/backroom.html

## The goals, in David's words

- "a dm supporting tool where I'm not losing ideas I have randomly and also not taking too long to deal with surprise player choices or the need for some filler"
- "loose stuff like this is the primary way of just entering random notes in". Notes must work as pasted, with no format to follow.
- Two ways of searching must both work:
  - a specific moment: "party stuck on a road at night"
  - a kind of situation: "split party", "random encounter", "event gone wrong"
- It is also a portfolio project, so it should look good to a recruiter.

## Rules that do not change

- **It finds, it never writes.** No text generation and no call to any AI service. Every result is text David wrote.
- **Notes are read, never changed.**
- **Everything runs on his computer.** The only network access is a one-time model download.
- **Do not touch `data/` or `logs/`.** They hold his real index, "used" marks and timing logs. Use a temporary folder for experiments. `npm run build:demo` takes `--no-log` for this reason.
- **`demo-sample/` is public, every word of it.** Only put notes there that David has approved.
- **Evaluation numbers:** do not invent any. Do not publish any unless David says so, and label honestly who wrote the test questions.
- **Tests use a stand-in for the model.** No model download in tests or in the automatic checks.

## How David likes to work

- Explain in plain language, as if to a beginner. Write acronyms out in full.
- For polish and presentation choices, pick one and do it, then say what was picked. He does not want a menu.
- Each of his portfolio projects should have its own look. Backroom's is a tabletop notebook (parchment by day, candlelight by night), not the portfolio's shared style.
- Hold anything that changes the live site until he says yes.
- His usage is limited. Keep this file current so work can resume from it.

## How it works

1. **Read** a folder of Markdown notes (`src/scan.ts`).
2. **Cut into ideas** (`src/chunk.ts`). Each paragraph or top-level bullet is one idea. Headings above it become its labels (note name, section, title). Ideas over 900 characters are cut at sentence ends.
3. **Fingerprint** each idea (`src/embed.ts`): the labels plus the text go through a small local model (all-MiniLM-L6-v2) that returns 384 numbers standing for what the idea is about.
4. **Search** (`src/search.ts`): the typed scene is fingerprinted the same way and compared with every idea.
5. **Remember** which ideas were used (`src/state.ts`), stored apart from the notes.

### What David's notes look like

Each idea is a title plus one paragraph of roughly 270 to 570 characters. Two layouts turn up, sometimes in one file:

```
## Section name            Section name
                           1. The Idea Title
### 1. The Idea Title      The paragraph, directly underneath.

The paragraph.             2. The Next Title
```

Both are read the same way. In the plain layout, a short numbered line directly above its text is the idea's title, and a short plain line directly above such an entry is the section. A note that opens with a `---` divider is not mistaken for a settings block. Labels are optional: an idea with no heading still works, using the file name as its only label.

Not handled: a blank line between a plain numbered title and its paragraph, and stray lines stuck to the end of a paragraph.

## Where things are

| Path | What it is |
|---|---|
| `src/` | The app: reading, cutting, fingerprinting, search, the local server, evaluation logic |
| `scripts/` | Command-line entry points (`index`, `search`, `serve`, `eval`, `build-demo`, ...) |
| `web/index.html` | The one web page, used by both the local app and the demo. `web/demo.ts` runs search in the browser for the demo |
| `web/fonts/` | Alegreya, Cinzel, IBM Plex Mono, served locally |
| `demo-sample/` | Public sample notes: 5 world notes plus 57 encounter and scenario ideas |
| `docs/` | The built demo that GitHub Pages serves. Never edit by hand; it is wiped and rebuilt |
| `tests/` | Vitest tests. Fixtures use made-up placeholder text, never real notes |
| `eval/dev/`, `eval/.work/` | Private evaluation sets and per-design indexes. Git-ignored |
| `assets/screenshot.jpg` | The README screenshot |

## Commands

```
npm test                                   83 tests
npm run typecheck
npm start -- "<notes folder>"              local app at http://127.0.0.1:5127
npm run build:demo -- demo-sample --no-log rebuild docs/ after changing web/ or demo-sample/
npm run preview:demo                       the built demo at http://127.0.0.1:5128
npm run eval -- --notes <folder> --scenes <file.json> --verbose
```

After `build:demo`, two font licence text files in `docs/fonts/` may show as changed because of line endings. Restore them with `git checkout -- docs/fonts/*.txt` if their content is the same.

Changing how notes are cut means raising `FORMAT_VERSION` in `src/indexer.ts`, so old indexes are rebuilt.

## Current state

- **Live and merged.** The tabletop-themed demo, the 57 notes, example searches, `?q=` links, the README opening with screenshot, the MIT license and automatic tests are all on `main`. Pull requests 1, 2 and 3 are merged.
- **Works offline.** Checked by indexing and searching with all outside connections blocked: zero outside connections attempted. The web demo is a website and needs a connection to load.
- **Evaluation harness is built** (`npm run eval`). It compares seven designs: ideas up to 300, 600, 900 or 1500 characters, labels off, keywords only, and meaning plus keywords.
- **A first evaluation is published in the README.** David asked for the test questions to be drafted by the AI assistant in his typing style. There are 67, over the public demo notes, in `eval/demo-scenes.json`. The README table says plainly that the questions were AI-drafted. He has not reviewed them one by one.
  - What it showed: the current defaults held up and no other design clearly beat them; keyword-only search was clearly worse; searching by kind of situation is the weak spot compared with searching for a specific moment (top 5 for 63% against 90%).
  - How far to trust it: the questions were written by an assistant that had read the notes, and there are only 86 ideas, so it is likely optimistic. Only 8 of the 67 questions are about a kind of situation.
  - The script that generated the question file is on David's computer at `eval/dev/make-demo-scenes.mts` (git-ignored).

## Next steps

1. **David skims `eval/demo-scenes.json`** and rewords or removes any question he would never type. Rerun and update the README table if it changes.
2. **Improve searching by kind of situation** ("random encounter", "filler", "side quest hook"). Add more kind-of-situation questions first (8 is too few to judge a change), then try ideas against them. Do not change the app's defaults without evaluation numbers to back the change.
3. **David runs a real session with it** on his real notes and reports what annoyed him.
4. **Update the portfolio page** for Backroom to match the new look. It lives in a different repository.
5. **Open question:** where do his ideas first land (one file, many files, his phone)? That decides whether a quicker way to add ideas is needed.
