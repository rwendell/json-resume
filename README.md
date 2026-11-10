# json-resume

The published resume site and JSON Resume source files.

This repository is intentionally site-only:

- `src/*.json` — published JSON Resume files
- `dist/` — generated HTML/PDF site (gitignored)
- `scripts/build.mjs` — render HTML, PDFs, and the site index
- `scripts/validate.mjs` — validate published resumes
- `scripts/watch.mjs` — development watch mode
- `scripts/publish.mjs` — publish a generated resume JSON into `src/`
- `.github/workflows/publish.yml` — build, gist mirror, and GitHub Pages deploy

Resume generation, job tailoring, interview answers, Upwork proposals, and
career data live in the separate [`dossier`](https://github.com/rwendell/dossier)
app.

## Requirements

- [aube](https://aube.jdx.dev)
- Node.js 20+
- Chromium for PDF export

```bash
aube ci
aube exec --no-install -- puppeteer browsers install chrome
```

## Validate and build

```bash
aube run validate -- all
aube run build
```

`build` renders every `src/*.json` into:

```text
dist/<name>/<name>.html
dist/<name>/<name>.pdf
dist/index.html
```

Useful maintenance commands:

| Command | Purpose |
| --- | --- |
| `aube run render -- <name>` | Render one resume as HTML |
| `aube run pdf -- <name>` | Export one resume as PDF |
| `aube run render-all` | Render all resumes as HTML |
| `aube run pdf-all` | Export all resumes as PDF |
| `aube run validate -- <name\|all>` | Validate one or all resumes |
| `aube run watch -- <name>` | Watch one resume during editing |
| `aube run index` | Regenerate only `dist/index.html` |

Themes can be passed through:

```bash
aube run render -- software-engineer jsonresume-theme-even
```

## Publish a dossier-generated resume

`dossier` writes files such as `resume-<slug>.json` in the current directory.
Publish one into this repo:

```bash
aube run publish -- /path/to/resume-<slug>.json
aube run publish -- /path/to/resume-<slug>.pdf --name my-resume
aube run publish -- resume.json --dry-run
aube run publish -- resume.json --no-build
```

The command:

1. validates the JSON Resume
2. writes `src/<name>.json`
3. rebuilds `dist/` unless `--no-build` is passed

It does not commit. Review the diff, then commit and push:

```bash
git add src/<name>.json
git commit -m "Publish <name> resume"
git push
```

Pushing to `main` triggers the Pages workflow, which validates, builds, mirrors
the JSON files to the configured gist, and deploys `dist/`.

## Manual resumes

Add or edit `src/<name>.json`, then run:

```bash
aube run validate -- <name>
aube run build
```

`dist/index.html` discovers resume labels from each file's `basics.label`, so no
resume names are hardcoded.

## Privacy

`src/*.json` is public. It intentionally contains the contact details used by
the published resumes. Treat every file in `src/` as publishable.

Generated/tailored resumes belong in the `dossier` app until you explicitly
publish one here. Do not put drafts, job descriptions, client details, or
private career data in this repository.
