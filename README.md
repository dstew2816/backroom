# Backroom

Searches your own Markdown notes for the ideas that fit the scene you type. It only finds and ranks text you wrote. It never generates anything and calls no AI service.

## Setup

Needs Node 20 or newer.

```
npm install
npm start -- "C:\path\to\your\notes"
```

Then open http://127.0.0.1:5127. After the first run the folder is remembered, so `npm start` is enough.

The first run downloads a small embedding model (about 25 MB, one time). That is the only network access. Everything after runs locally.

Your notes are only read. The index, the usage state and the logs are written to `data/` and `logs/` in this project, and both are git-ignored.

## Using the web page

- Type the current situation, press Search (or Ctrl+Enter).
- Each result is one idea (a paragraph or a top-level bullet) with its note, heading and line numbers.
- **Mark used** records it in `data/state.json`. **Unused only** hides those.
- **Resurface old prep** gives ideas you've never used, or haven't used in a long time, a small boost.
- **Re-index** picks up notes you added or edited. Only changed files are processed.

## Command line

```
npm run index -- "<notes folder>"        build or refresh the index
npm run search -- "<scene>"              options: -n 8, --unused, --tag x, --folder "sub/folder", --stale, --reindex
npm run used -- 2                        mark result #2 of the last search as used (add --undo)
npm run chunks -- "<notes folder>"       show how the notes are split into ideas (add --all)
npm run timings                          summarise logs/timings.jsonl
npm run eval -- --notes <folder> --scenes <file>   compare design choices (see Evaluation)
npm test
```

## Static demo (GitHub Pages)

The demo ships a precomputed index and runs the search in the visitor's browser. It makes no outside requests; the model and runtime files are served from the same site.

1. Put the notes you are happy to make public in `demo-sample/`. Every word of that folder becomes public text in the built site.
2. `npm run build:demo -- demo-sample` (writes `docs/`)
3. `npm run preview:demo` to check it locally at http://127.0.0.1:5128
4. Commit `docs/` and `demo-sample/`, then in the repository settings set Pages to deploy from the `main` branch, `/docs` folder.

First visit downloads about 36 MB (model and runtime); the browser caches it afterwards. "Used" marks in the demo are stored in the visitor's browser only.

The build refuses folders outside `demo-sample/` unless you pass `--allow-outside`.

## Evaluation

**Status: nothing has been measured yet on real notes.** The tool below is built and tested with stand-in (fake) data only. No scores are quoted anywhere in this repository.

The question it answers: when I type a scene, how often does the right idea show up near the top of the results? That lets design choices (idea size, heading context, keyword matching) be compared with numbers instead of by feel. It only finds and ranks text you wrote; it never writes text.

```
npm run eval -- --notes "<notes folder>" --scenes <scenes.json>
```

Optional: `--work <folder>` (where the per-design indexes go; default `eval/.work/<scenes file name>`), `--external "Smart Connections=<file.json>"` (repeatable), `--verbose` (list scenes where the baseline missed the top 10), `--json <file>` (also write the numbers to a file). The first run downloads the search model if it is not already cached, and builds one index per design, so it takes a while.

### What is measured

For each scene, the harness finds the position ("rank") of the first result that contains the expected idea. Then:

- **Recall at 5**: the share of scenes where the right idea is in the top 5 results.
- **Recall at 10**: the share of scenes where the right idea is in the top 10 results.
- **Mean reciprocal rank** (MRR): for each scene take 1 divided by the rank (1 for first place, 0.5 for second, 0.33 for third, and 0 if the idea is not found at all), then average over all scenes. It rewards putting the right idea higher up. 1.0 is perfect.
- **Not found**: scenes where the idea appeared nowhere in the ranking.

Worked example: five scenes with ranks 1, 3, 7, 12 and not found give recall at 5 = 2/5, recall at 10 = 3/5, and MRR = (1 + 1/3 + 1/7 + 1/12 + 0) / 5.

The harness calls the app's real search code, so it measures what the app actually does.

### Scene file format

JSON. Either an object, or a bare list of scenes:

```json
{
  "label": "My scenes",
  "publishable": false,
  "scenes": [
    { "scene": "The party arrives at a harbor town at night", "file": "places/harbor.md", "expect": "the harbor master takes bribes" },
    { "scene": "A chase across rooftops", "expect": ["rooftop chase", "slate tiles are slick"] }
  ]
}
```

- `scene` (required): the text you would search with.
- `expect` (required): a short, distinctive snippet of the idea that should come back, or a list of snippets (any one counts).
- `file` (optional): the note's path relative to the notes folder. Narrows the match to that note.
- `label` (optional): a name printed above the results.
- `publishable` (optional): `false` prints a "do not publish" banner. Use it for synthetic or private sets.

### How the expected idea is identified

By a snippet of its text, checked with "contains" against each result's text after markdown marks (bold, links and so on) are stripped, ignoring capitals and extra spaces. Ideas have no titles, an idea's ID includes a hash of its text so it changes whenever the idea size changes, and line numbers shift when notes are edited. A text snippet stays the same across all the design variants.

Caveat: if a small idea size cuts your snippet in half, the idea counts as "not found". Keep snippets short (6 to 10 words) and near the start of the idea.

### Comparing other tools (for example Smart Connections)

Run the other tool on the same scenes yourself and save its results as JSON, best result first:

```json
[
  { "scene": "The party arrives at a harbor town at night", "results": ["text of result 1", "Harbor Notes", "text of result 3"] }
]
```

Each result is either the result's text or just the note's name. The `scene` text must match the scenes file exactly. A result counts as correct if it contains the expected snippet, or if it is exactly the expected note's name (when `file` is given). Pass it with `--external "Smart Connections=results.json"`.

### One index folder per design

An index records which design choices built it, and a different choice means the old index is not reused. The harness therefore keeps a separate index folder for each design under the `--work` folder. If you build indexes yourself, never point two designs at the same folder. `eval/dev/` and `eval/.work/` are git-ignored.

### Designs compared

1. Baseline: ideas up to 900 characters, note title and headings added before searching, meaning-based search (embeddings).
2. Ideas up to 300 characters.
3. Ideas up to 600 characters.
4. Ideas up to 1500 characters.
5. No heading context (the idea's own text only).
6. Keywords only, using BM25 (a standard word-matching score where rare words count for more).
7. Hybrid: meaning and keyword rankings combined with reciprocal rank fusion (each ranking gives an idea 1 / (60 + its position) points and the points are added).

## Notes on how it works

- Notes are split on headings, paragraphs and top-level bullets. A bullet's indented children stay with it. One-line bullets are kept. Paragraphs over about 900 characters are split at sentence boundaries.
- Each idea is embedded with its note title and heading trail for context (all-MiniLM-L6-v2, 8-bit quantised, via transformers.js).
- A scene is embedded when you search, so new text never needs indexing to be used as a query. New notes do need a re-index before they can be found.
- Scores are cosine similarity. The page also shows `z`, how far above the average idea in your notes the match scores, and draws a divider where relevance drops sharply.
- Usage state is keyed on the idea's text, not its line number, so marks survive edits above it. Rewriting the idea itself counts as a new idea.
