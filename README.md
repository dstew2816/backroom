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

## Notes on how it works

- Notes are split on headings, paragraphs and top-level bullets. A bullet's indented children stay with it. One-line bullets are kept. Paragraphs over about 900 characters are split at sentence boundaries.
- Each idea is embedded with its note title and heading trail for context (all-MiniLM-L6-v2, 8-bit quantised, via transformers.js).
- A scene is embedded when you search, so new text never needs indexing to be used as a query. New notes do need a re-index before they can be found.
- Scores are cosine similarity. The page also shows `z`, how far above the average idea in your notes the match scores, and draws a divider where relevance drops sharply.
- Usage state is keyed on the idea's text, not its line number, so marks survive edits above it. Rewriting the idea itself counts as a new idea.
