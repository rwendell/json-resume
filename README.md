# JSON Resume Builder

This repo generates HTML and PDF files, publishes them to `rwendell.github.io`, and mirrors the JSON files to a public GitHub Gist for sharing.

## Architecture

```text
src/*.json (this repository)
        ↓
GitHub Actions
        ├── dist/index.html, pages/, pdf/
        ├── rwendell.github.io
        └── public JSON Resume gist
```

## Resume data

Resume files live in `src/`. Adding or removing a `.json` file there automatically adds or removes it from the generated site and gist on the next publish.

The generated `dist/index.html` discovers resume labels from each file's `basics.label` field. No resume names are hardcoded in the website JavaScript.

## Setup

Install dependencies with **aube**:

```bash
aube ci
```

Use the package scripts through aube:

```bash
aube run validate -- all
aube run build
aube run render -- software-engineer
aube run pdf -- software-engineer
aube run watch -- software-engineer
```

Generated files are placed in `dist/<resume>/` and `dist/index.html`.

## Available commands

| Command | Purpose |
| --- | --- |
| `aube run build` | Build HTML, PDFs, and the dynamic site index |
| `aube run render -- <name>` | Render one resume as HTML |
| `aube run pdf -- <name>` | Export one resume as PDF |
| `aube run render-all` | Render all resumes as HTML |
| `aube run pdf-all` | Export all resumes as PDF |
| `aube run validate -- <name>` | Validate one resume |
| `aube run validate -- all` | Validate all resumes |
| `aube run watch -- <name>` | Development watch mode |

Themes can be passed to render commands:

```bash
aube run render -- software-engineer jsonresume-theme-even
```

## Project structure

```text
src/                          Resume JSON source files
scripts/build.mjs             HTML, PDF, and index generation
scripts/validate.mjs          JSON Resume validation
scripts/watch.mjs             Development watch mode
.github/workflows/publish.yml Build, gist mirror, and deployment
```

Resume files follow the [JSON Resume schema](https://jsonresume.org/) and use the `jsonresume-theme-straightforward` theme by default.
