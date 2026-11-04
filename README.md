# JSON Resume Builder

This repo keeps your manually written resumes in `src/` and generates tailored
resumes for specific jobs from:

- `data/career.yml` — your public career fact bank
- `data/career.private.yml` — optional gitignored PII overlay (name, contact
  details, location)
- `data/github.json` and `data/local-projects.json` — your GitHub, org, and
  local projects
- a job URL or job description file

Generated resumes are private, overwritten on each run, and never touch the
published resumes in `src/`. The final deliverable is a **one-page PDF**.
Intermediate JSON, trace, and job data live in `.cache/tailor/`.

## Quick start

### Prerequisites

- [aube](https://aube.jdx.dev)
- [OpenCode CLI](https://opencode.ai) with at least one model configured
- Optional: an OpenCode Go subscription or OpenRouter credit for fallback when
  the free model is unavailable
- [GitHub CLI](https://cli.github.com) authenticated with `gh auth login`

Install dependencies:

```bash
aube ci
```

### Generate a resume

Paste a job URL:

```bash
aube run tailor -- https://boards.example.com/acme/jobs/123
```

Or use a local job description:

```bash
aube run tailor -- job.md
```

The result is written to:

```text
generated/resumes/resume-acme-data.pdf
```

The PDF opens automatically in your default viewer. Use `--no-open` when
running in a script or over SSH.

The resume must fit on exactly one page and should fill it. If the first draft
is longer, `tailor` trims lower-value content in small steps and re-renders. If
the result is too sparse (more than roughly two lines short of the printable
page), it adds unused achievements from the merged fact bank. It fails rather than
leaving a multi-page or mostly-empty PDF.

### Check the result

```bash
aube run verify-resume -- acme-forward-deployed-engineer
```

### Answer an application question

```bash
aube run answer -q "Why do you want this role?"
```

## When free usage runs out

`tailor` and `answer` default to `--provider auto`, which tries providers in
this order:

1. the free OpenCode model, using `opencode/deepseek-v4.1-flash-free#high`
2. OpenCode Go, using `opencode-go/deepseek-v4.1-flash#high`
3. OpenRouter, using `openrouter/deepseek/deepseek-v4.1-flash-1017#high`

A provider is retried only when it exits non-zero, returns no JSON object, or
returns JSON that does not match the expected shape. The command prints which
provider produced the draft:

```text
tailor: OpenCode (opencode/deepseek-v4.1-flash-free#high) failed: exited with status 1; trying the next provider
tailor: draft from OpenCode Go (opencode-go/deepseek-v4.1-flash#high)
```

Force a provider when you already know the free quota is gone:

```bash
aube run tailor -- job.md --provider go
aube run answer -q "Why this role?" --provider openrouter
```

Provider values:

| Value | Meaning |
| --- | --- |
| `auto` | Try OpenCode, OpenCode Go, then OpenRouter (default) |
| `opencode` | Free OpenCode model only |
| `go` | OpenCode Go only |
| `openrouter` | OpenRouter only |

Environment overrides:

```bash
export RESUME_LLM_PROVIDER=go
export OPENCODE_MODEL=opencode/deepseek-v4.1-flash-free#high
export OPENCODE_GO_MODEL=opencode-go/deepseek-v4.1-flash#high
export OPENROUTER_MODEL=openrouter/deepseek/deepseek-v4.1-flash-1017#high
```

The defaults pin `#high`, DeepSeek's normal thinking effort. They never request
`#max`. For a faster run, override the Go or OpenRouter model with `#low`:

```bash
export OPENCODE_GO_MODEL=opencode-go/deepseek-v4.1-flash#low
```

The commands use the credentials already connected to OpenCode. If a provider
is missing, connect it once with `opencode auth login` (or `/connect` in the
TUI) and select it.

`--model provider/model#variant` bypasses the fallback chain and uses exactly
one model. That is the right choice when you need a specific model, but it will
not fall back when that model's quota is exhausted.

A typical tailoring run costs a fraction of a cent on the OpenRouter default.
Check the remaining credit with:

```bash
curl -s https://openrouter.ai/api/v1/credits \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  | jq '{remaining: (.data.total_credits - .data.total_usage)}'
```

## Provide the job description

### Option 1: Job URL

```bash
aube run tailor -- https://boards.example.com/acme/jobs/123
```

The command fetches the page, prefers schema.org `JobPosting` JSON-LD, and falls
back to readable page text. JavaScript-heavy pages are retried with headless
Chrome.

If the site requires login or blocks scraping, save the description to a file
and use option 2 instead. You can also supply overrides:

```bash
aube run tailor -- https://example.com/job \
  --title "Staff Platform Engineer" \
  --company "Acme"
```

### Option 2: Markdown file

Create a file with optional frontmatter:

```md
---
company: Acme Data
title: Forward Deployed Engineer
url: https://example.com/jobs/forward-deployed-engineer
---

The full job description...
```

Then run:

```bash
aube run tailor -- job.md
```

### Option 3: Inline text

```bash
aube run tailor -- \
  --company "Acme" \
  --title "Forward Deployed Engineer" \
  --description job.txt
```

`--description` accepts text, a file path, or a URL.

## What gets generated

The final deliverable is one PDF:

```text
generated/resumes/resume-<company>.pdf
```

PDF naming:

- One generated job at a company: `resume-<company>.pdf`
- Multiple generated jobs at the same company: `resume-<company>-<title>.pdf`

When a second job at a company is generated, the existing company-only PDF is
renamed to include its title automatically.

The intermediate JSON lives in a hidden cache:

```text
.cache/tailor/resume-<company>-<title>/
  resume.json
  trace.json
  requirements.json
  github-candidates.json
  job.md
  meta.json
```

| File | Purpose |
| --- | --- |
| `generated/resumes/resume-<company>.pdf` | Final one-page PDF (title appended when multiple) |
| `.cache/.../resume.json` | Tailored JSON Resume |
| `.cache/.../trace.json` | Maps every bullet/project to its evidence |
| `.cache/.../requirements.json` | Extracted job requirements |
| `.cache/.../github-candidates.json` | Project candidates considered (GitHub/org/local) |
| `.cache/.../job.md` | Saved job description + metadata |
| `.cache/.../meta.json` | Company/title and PDF filename mapping |

No HTML is written. The cache is kept so `verify-resume` and `answer` can reuse
the same resume, trace, and job context. It is gitignored. To remove it:

```bash
aube run clean-cache
```

Or delete only this run's cache after a successful PDF:

```bash
aube run tailor -- job.md --clean-cache
```

Re-running the same job overwrites the PDF and cache. Use `--slug` to choose the
cache/answer key; PDF names still follow the company rule:

```bash
aube run tailor -- https://example.com/job --slug acme-fde
# cache: .cache/tailor/resume-acme-fde/
# PDF:   generated/resumes/resume-acme.pdf
```

Manual resumes in `src/` are never modified.

## Build a generic resume

For a general-purpose resume that is not tied to one job:

```bash
aube run tailor --generic
# generated/resumes/resume-generic.pdf
```

The generic criteria live in `data/career.yml` under `generic:`. By default it
prioritizes high-`strength` achievements, quantified outcomes, breadth across
full-stack/backend/data/cloud/security/customer-facing work, and 2–3 projects
from different domains. It publishes to `src/software-engineer.json` by default
via `generic.publishAs`. Edit that section to change the emphasis or target.

Use `--title` to change the headline or `--slug` to choose a different cache/PDF
name:

```bash
aube run tailor --generic --title "Senior Software Engineer" --slug generic-senior
# generated/resumes/resume-generic-senior.pdf
```

For a role-family base (for example, forward-deployed engineering), give the
tool a short representative job description instead of `--generic`.

## Publishing generated resumes

Generic resumes and resumes whose title matches an existing published resume are
automatically promoted:

- The verified JSON replaces the matching `src/<name>.json`
- `dist/<name>/<name>.html` and `.pdf` are regenerated
- `dist/index.html` is refreshed

Title matching uses the job title against each `src/*.json` file's
`basics.label`, then against its filename slug. Unmatched job titles stay private
in `generated/resumes/` and `.cache/tailor/`.

Use `--no-publish` to keep a run private even when it matches:

```bash
aube run tailor -- job.md --no-publish
```

These files are public if the repository is public. A company-specific tailored
resume with a matching title will replace the published version; use
`--no-publish` when that is not what you want.

## Explain project scoring

```bash
aube run score-projects -- --generic
aube run score-projects -- job.md
aube run score-projects -- --title "Go Platform Engineer" --description job.txt
```

The table shows each candidate’s token-match score, whether it is pinned, its
evidence id, and the exact tokens matched. Score is the number of distinct job
tokens found in the project name, description, topics, languages, local commits,
and README. Pinned projects only break ties; they do not add points.

The top 12 candidates are passed to the resume model, which chooses the final
2–3 projects. Use `--json` for machine-readable output.

## Check a generated resume

```bash
aube run verify-resume -- acme-forward-deployed-engineer
# or by PDF:
aube run verify-resume -- generated/resumes/resume-acme-data.pdf
```

Verification checks:

- JSON Resume schema validity
- Employers, titles, and dates against the merged public/private fact bank
- Numeric claims against their cited evidence
- Trace coverage for every bullet and project
- Projects were actual candidates for this job
- Skills came from the fact bank
- The PDF is exactly one page (hard failure otherwise)

It also prints requirement coverage and honest gaps. A gap means the job asks
for something your fact bank does not currently support. That is useful
information for a cover letter or interview prep, not a reason to invent a
claim.

## Answer application and interview questions

Use the same job context, fact bank, GitHub candidates, and generated
resume/trace to answer a question:

```bash
# shortcut: reuse the most recent tailor run
aube run answer -q "Why do you want this role?"

# target a generated resume by slug
aube run answer -- acme-forward-deployed-engineer \
  -q "Why do you want this role?"

# with a fresh job URL, even if no resume exists yet
aube run answer -- https://example.com/job \
  -q "Tell me about a time you improved reliability."

# read the question from a file
aube run answer -- acme-forward-deployed-engineer -q question.txt

# add context to guide the answer
aube run answer -q "Why this role?" \
  --hint "Emphasize customer-facing work and the Snowflake migration"
```

If you omit the job URL/file/slug, it uses the most recent tailor run with a
matching cache. If a generated resume exists for the
slug, the answer uses it as the primary framing, along with its trace and GitHub
candidates from `.cache/tailor/resume-<slug>/`. If no resume exists, the answer
uses the career fact bank, job description, and selected GitHub candidates. The
job description is saved there so later answers can reuse it. If you ran
`clean-cache`, pass the job URL/file again instead of the slug.

Answers are written to:

```text
generated/answers/resume-<slug>.answer-<question-slug>.md
generated/answers/resume-<slug>.answer-<question-slug>.json
```

The Markdown file contains the ready-to-use answer. The JSON file contains the
job/question metadata, structured claims, evidence, gaps, follow-up notes, and
the provider/model/cost that produced the draft.
The answer is printed to the terminal and copied to the clipboard. Clipboard
copying tries `wl-copy`, `xclip`, `xsel`, `clip.exe`, and `pbcopy`/`clip`
depending on the platform. Use `--no-copy` to skip it.

The command verifies that every factual claim cites a real achievement, role
date, project, or GitHub candidate, and that numbers match the cited source. It
reports gaps instead of inventing an answer. Use `--name` to control the answer
filename:

```bash
aube run answer -- acme-forward-deployed-engineer \
  --question "Why this role?" \
  --name why-acme
```

Answer options:

| Option | Purpose |
| --- | --- |
| `--question, -q <text or file>` | Question to answer (required) |
| `--hint, -h, -H <text or file>` | Additional context to guide emphasis or tone |
| `--slug <name>` | Generated resume slug to reuse |
| `--name <name>` | Answer filename slug |
| `--title`, `--company` | Override job metadata |
| `--url`, `--description` | Job source when not using a positional input |
| `--provider` | Model provider: `auto`, `opencode`, `go`, or `openrouter` |
| `--model` | Use one exact model and skip provider fallback |
| `--timeout` | Per-provider timeout in seconds |
| `--refresh` | Force a GitHub/org + local project refresh |
| `--no-sync` | Skip the 24-hour GitHub refresh |
| `--no-copy` | Do not copy the answer to the clipboard |
| `--debug` | Save the prompt and raw OpenCode output |

Aube reserves exact `-h` for its own help. Without `--`, use `--hint "..."`,
`-H "..."`, or `-h="..."`; `-h "..."` works after `--` or when invoking the
script directly.

## Edit your career fact bank

`data/career.yml` is the public source of truth for generated resumes. It
contains roles, achievements, projects, skills, education, constraints, and
transferable terms, and is safe to commit.

Keep PII in `data/career.private.yml`: your name, email, phone, and location.
That file is gitignored and merged over the public file at runtime:

```yaml
# data/career.private.yml — private, gitignored
basics:
  name: Your Name
  email: you@example.com
  phone: (555) 555-5555
  location:
    city: Your City
    region: Your State
    countryCode: US
```

Arrays merge by `id` for roles, achievements, projects, and education; by
`name` for skill groups; and by `evidence` for `transferable` entries. String
arrays such as `constraints` and `exclude` are unioned. Scalar values in the
private file override the public file.

Each achievement needs a stable `id` so the verifier can prove the generated
bullet is grounded:

```yaml
roles:
  - id: northern-trust
    company: Northern Trust
    position: Senior Associate - Software Engineer
    startDate: 2022-08
    endDate: 2026-02
    achievements:
      - id: nt-kafka
        text: >-
          Optimized Oracle SQL schemas and stored procedures, JPA/Hibernate
          mappings, and high-throughput Apache Kafka pipelines processing 2.5M
          daily transactions.
        skills: [oracle-sql, sql, jpa, hibernate, kafka, performance]
```

Rules that keep the output trustworthy:

- Keep achievements atomic: one claim per entry.
- Preserve numbers exactly as written.
- Only add a skill or technology that the achievement text or tags support.
- Use `transferable` entries to name adjacent capabilities that a source
  achievement supports, such as a React dashboard supporting dashboard UI and
  data-visualization work. Transferable terms still require the source evidence
  to be cited.

```yaml
transferable:
  - evidence: bb-dashboard
    terms: [Dashboards, UI Development, Data Visualization]
```

- Put anything you do not want claimed in `constraints`.
- If a requirement has no evidence, let the tool report a gap.

The tailoring and answer agents may research the target company, role, or an
unfamiliar technology online. Web content can shape wording and context, but it
is never evidence for a claim about your experience. The fact bank and project
candidates remain the only sources for candidate facts.

### Pull the private PII overlay from a secret gist

Keep `data/career.private.yml` in a secret gist and pull it down on another
machine:

```bash
aube run pull-private
```

The command resolves the gist in this order:

1. `--gist <id|url>`
2. `CAREER_PRIVATE_GIST_ID`
3. the newest secret gist containing `career.private.yml`

```bash
aube run pull-private -- --gist <id|url>
export CAREER_PRIVATE_GIST_ID=<id>
```

Create or update the gist with the GitHub CLI:

```bash
gh gist create data/career.private.yml
gh gist edit <id> --filename career.private.yml data/career.private.yml
```

`gh gist create` creates a secret gist by default. The pull command refuses
public gists unless `--allow-public` is passed, validates the YAML before
writing, never prints the contents, and backs up a changed local file under
`.cache/pull-private/`.

## Project sources

`aube run tailor` refreshes project metadata automatically when it is missing or
older than 24 hours. To refresh manually:

```bash
aube run sync-github   # GitHub + local projects
aube run sync-local    # only ~/projects
```

You normally do not need to run these manually:

- `tailor` rescans local `~/projects` on every run and refreshes GitHub/org
  metadata when it is missing or older than 24 hours.
- `tailor --refresh` forces the GitHub/org and local refresh immediately.
- `answer` reuses the candidate list from the generated resume when one exists.
  Regenerate the resume to pick up new projects. Without a cached resume, it
  refreshes stale sources automatically; `--refresh` forces it.

`sync-github` pulls:

- Your public personal repositories
- Repositories in organizations you belong to where you have commits or PRs
  (public and private)
- Local projects under `~/projects` that are not already represented by GitHub

Local projects have their README, manifests, languages, and your local commit
messages included. A checkout of an upstream project is excluded unless you have
local commits, so a fresh clone is not treated as your work.

Curated projects in `data/career.yml` are the default. Synced projects are
candidates: the model may include a few that directly support the job, and the
verifier requires them to have been in `github-candidates.json`.

Evidence ids depend on the source:

```text
github:<repo>               personal GitHub repo
github:<owner>/<repo>       organization repo
local:<project>             local ~/projects project
```

Exclude sources in `data/career.yml` or the private overlay:

```yaml
github:
  username: rwendell
  exclude:
    - dotfiles
    - nvim-config

local:
  root: ~/projects
  exclude:
    - gists
  include: []
```

`data/github.json` and `data/local-projects.json` are gitignored because they can
contain private org READMEs and local project paths. Do not commit them.

## Daily commands

| Command | Purpose |
| --- | --- |
| `aube run tailor -- <job file or URL>` | Generate and render a tailored resume |
| `aube run tailor --generic` | Build the general-purpose resume |
| `aube run score-projects -- <job or --generic>` | Explain project candidate scores |
| `aube run answer -q "..."` | Answer using the most recent tailor run |
| `aube run answer -- <job or slug> -q "..."` | Answer for a specific job |
| `aube run verify-resume -- <file or slug>` | Verify a generated resume and trace |
| `aube run sync-github` | Refresh GitHub, org, and local project metadata |
| `aube run sync-local` | Refresh only local `~/projects` metadata |
| `aube run pull-private` | Pull the private PII overlay from a secret gist |
| `aube run clean-cache` | Remove all intermediate resume JSON |

Common `tailor` options:

| Option | Purpose |
| --- | --- |
| `--title`, `--company` | Override metadata from the URL or file |
| `--generic` | Build a general-purpose resume from the fact bank |
| `--slug` | Choose the cache/answer key |
| `--provider` | Model provider: `auto`, `opencode`, `go`, or `openrouter` |
| `--model` | Use one exact model and skip provider fallback |
| `--theme` | Use a different JSON Resume theme |
| `--no-render` | Write cache JSON/trace only, skip the PDF |
| `--no-open` | Do not open the rendered preview |
| `--clean-cache` | Delete this run's intermediate JSON after success |
| `--refresh` | Force a GitHub/org + local project refresh |
| `--no-publish` | Keep the generated resume private |
| `--no-sync` | Skip the 24-hour GitHub refresh |
| `--debug` | Save the prompt and raw OpenCode output |
| `--timeout` | Per-provider timeout in seconds (default 600) |

## Publishing manual resumes

Published resumes live in `src/`. Adding or removing a `.json` file there
automatically adds or removes it from the generated site and gist on the next
publish.

The generated `dist/index.html` discovers resume labels from each file's
`basics.label` field. No resume names are hardcoded in the website JavaScript.

Generated files are private by default. Copy one into `src/` if you want the
site and gist to publish it.

## Maintenance commands

| Command | Purpose |
| --- | --- |
| `aube run build` | Build HTML, PDFs, and the dynamic site index |
| `aube run index` | Regenerate `dist/index.html` only |
| `aube run render -- <name>` | Render one resume as HTML |
| `aube run pdf -- <name>` | Export one resume as PDF |
| `aube run render-all` | Render all resumes as HTML |
| `aube run pdf-all` | Export all resumes as PDF |
| `aube run validate -- <name>` | Validate one resume |
| `aube run validate -- all` | Validate all published resumes |
| `aube run watch -- <name>` | Development watch mode |

Themes can be passed to render commands:

```bash
aube run render -- software-engineer jsonresume-theme-even
```

## Privacy

- `generated/` and `.cache/` are gitignored. Tailored resumes and generated
  answers contain company names and application-specific positioning; keep them
  private.
- `src/*.json` is **public**: the publish workflow mirrors every file there to
  the website and gist. Do not put tailored resumes in `src/`.
- `data/github.json` and `data/local-projects.json` are gitignored because they
  can contain private organization READMEs and local project paths.
- `data/career.yml` is **public** and contains your roles, achievements,
  projects, skills, education, and constraints. PII — name, email, phone, and
  location — belongs in `data/career.private.yml`, which is gitignored and
  merged at runtime.
- `src/*.json` intentionally contains the contact details used by the published
  resumes. If you want to remove PII from the live site, sanitize those files
  too.
- Removing private data from a tracked file does not remove it from existing
  Git history. Rewrite history if private data was pushed.
- Provider credentials live in OpenCode's auth store or your environment. Do not
  commit `.env`; it is gitignored.

## Troubleshooting

**The URL will not load or only shows a login page.** Save the job text to a file
and run `aube run tailor -- job.md`. Many job boards block automated requests.

**The title or company is wrong.** Pass `--title` and `--company` explicitly.

**OpenCode fails or times out.** Confirm `opencode run "hello"` works in the
repo, then try `--provider go` or `--provider openrouter`. If both fail, check
`opencode auth list`, try `--model provider/model#variant`, and raise
`--timeout`. The automatic chain logs each provider failure, so the final error
shows which quota or credential blocked the run.

**Verification fails.** Read the printed errors. Generated files are preserved
in `.cache/tailor/resume-<slug>/` so you can inspect `resume.json`,
`trace.json`, and `requirements.json`. `verify-resume` can be re-run without
regenerating while the cache exists.

**The answer command cannot find a saved job.** Generate the resume first, pass
the job URL/file directly, or pass `--slug` with a slug that exists under
`.cache/tailor/`. If you ran `clean-cache`, use the URL/file again. With no job
argument at all, it uses the most recent tailor run with a cache; if none
exists, it cannot guess.

**An answer fails verification.** Inspect the raw output path printed by the
command. Regenerate, or ask a narrower question that maps to specific
achievements. Answers with no factual claims (for example, questions to ask the
interviewer) are allowed but may print a review warning.

**PDF rendering fails.** Check that Chromium is available with:

```bash
aube exec --no-install -- puppeteer browsers install chrome
```

**The PDF is still longer than one page.** `tailor` trims lower-value bullets,
projects, and skill keywords automatically, then fails if it still cannot fit.
If that happens, target a more focused job description or remove lower-value
content from the merged fact bank. The multi-page PDF and cache are preserved
for inspection.

**The PDF is too sparse.** `tailor` first tries unused achievements from
the merged fact bank to fill the page. If none fit, add more achievements to
`data/career.yml` (or a relevant project) and regenerate. It will not silently
ship a mostly-empty page.

**The preview does not open.** `tailor` tries `open`, `xdg-open`, `kde-open`,
and other common desktop openers. If none are available, open the printed file
path manually or pass `--no-open`.

## Project structure

```text
data/career.yml               Public career fact bank
data/career.private.yml       Private PII overlay (gitignored)
data/github.json              Synced GitHub/org metadata (gitignored)
data/local-projects.json      Scanned ~/projects metadata (gitignored)
generated/resumes/            Private tailored PDFs (gitignored)
generated/answers/            Private application/interview answers (gitignored)
.cache/tailor/                Intermediate resume JSON/trace (gitignored)
src/                          Published resume JSON source files
scripts/build.mjs             HTML, PDF, and index generation
scripts/validate.mjs          JSON Resume validation
scripts/watch.mjs             Development watch mode
scripts/sync-github.mjs       GitHub/org metadata sync + local trigger
scripts/sync-local-projects.mjs Local ~/projects discovery
scripts/tailor.mjs            Job -> one-page PDF orchestration
scripts/answer.mjs            Job/question -> grounded application answer
scripts/pull-private.mjs       Pull private PII overlay from a secret gist
scripts/score-projects.mjs    Project scoring explainer
scripts/verify-resume.mjs     Schema, trace, evidence, and one-page checks
scripts/clean-cache.mjs       Remove intermediate resume cache
scripts/lib/career.mjs        Public/private fact-bank merge
scripts/lib/job-input.mjs     Job URL/file/frontmatter parsing
scripts/lib/job-page.mjs      Job URL fetching and HTML extraction
scripts/lib/github-projects.mjs Project candidate selection/scoring
scripts/lib/output-paths.mjs  PDF naming, cache metadata, aliases
scripts/lib/opencode.mjs      OpenCode invocation and output parsing
scripts/lib/llm.mjs           Provider chain and fallback selection
scripts/lib/open-file.mjs     Desktop preview opener fallbacks
scripts/lib/clipboard.mjs     Clipboard copy fallbacks
scripts/lib/numbers.mjs       Numeric suffix normalization
scripts/lib/resume-format.mjs Theme punctuation normalization
scripts/lib/one-page.mjs      One-page trimming and fill expansion
scripts/lib/page-fill.mjs     HTML layout fill measurement
scripts/lib/pdf.mjs           PDF page counting
.opencode/agents/             OpenCode tailoring and answer agents
.github/workflows/publish.yml Build, gist mirror, and deployment
```

Resume files follow the [JSON Resume schema](https://jsonresume.org/) and use
the `jsonresume-theme-straightforward` theme by default.
