# JSON Resume Builder

A system for generating professional resumes from JSON data, using a modular architecture with GitHub Gists for data storage and GitHub Pages for hosting.

## Architecture Overview

This project uses a new dynamic architecture:

1. **GitHub Gist** (`gists/json-resume/`) - **SOURCE OF TRUTH**: Stores all resume JSON data
2. **This Repository** (`json-resume/`) - Generates HTML/PDF resumes from gist data
3. **GitHub Pages** (`rwendell.github.io/`) - Hosts the generated resumes

## How It Works

The workflow now reads directly from the gist as the single source of truth:

1. **Fetch resume files**: Queries the gist API to discover available resumes
2. **Exclude non-resume files**: Filters out `JSON-RESUME` and other irrelevant files
3. **Download and prepare**: Downloads resume content from the gist to `src/`
4. **Generate resumes**: Builds HTML/PDF files from the gist-sourced data
5. **Update metadata**: Updates gist description only (preserves file history)

## Available Resumes

The available resumes are determined by what JSON files exist in the gist:
- **Software Engineer** - Ryan Wendell's primary tech role resume
- **Product Manager** - Ryan's product management experience  
- **Barista** - Ryan's earlier coffee shop experience

Each resume includes work history, education, skills, projects, and volunteer experience.

## Dynamic Behavior

✅ **Source of truth**: The gist controls which resumes exist
✅ **Auto-sync**: Adding/removing files in the gist automatically updates generated resumes
✅ **Clean separation**: Non-resume files (like `JSON-RESUME`) are excluded
✅ **No data loss**: Existing file history is preserved

## Management Workflow

**To add a new resume:**
1. Add the JSON file directly to the gist
2. Push to this repository (triggers workflow)
3. Resume is automatically generated and deployed

**To remove a resume:**
1. Delete the JSON file from the gist
2. Push to this repository (triggers workflow)
3. Resume generation stops automatically

**For documentation:** Store non-resume files like `JSON-RESUME` in the gist - they're excluded from processing.

## Usage

### Prerequisites

- Node.js (v20+ recommended)
- GitHub access with a Gist token

### Installation

```bash
npm ci
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run render <name>` | Generate HTML resume for a specific version (e.g., `npm run render barista`) |
| `npm run pdf <name>` | Generate PDF resume for a specific version (e.g., `npm run pdf software-engineer`) |
| `npm run render-all` | Generate HTML resumes for all versions |
| `npm run pdf-all` | Generate PDF resumes for all versions |
| `npm run build` | Generate both HTML and PDF for all versions |
| `npm run validate <name>` | Validate a resume JSON file (e.g., `npm run validate barista`) |
| `npm run validate all` | Validate all resume JSON files |
| `npm run watch <name>` | Watch a resume JSON file and rebuild HTML on changes |

### Examples

```bash
# Generate a barista resume as HTML
npm run render barista

# Generate a software engineer resume as PDF
npm run pdf software-engineer

# Generate all resumes as both HTML and PDF
npm run build

# Validate all resumes
npm run validate all
```

## Development

### Watch Mode

Use `npm run watch <name>` to automatically rebuild the HTML resume when the JSON source changes:

```bash
npm run watch barista
```

This is useful for testing different themes or making quick updates.

### Custom Themes

You can use different themes with the render command:

```bash
npm run render barista jsonresume-theme-even
```

See the [JSON Resume Themes](https://github.com/jsonresume/themes) for available themes.

## Configuration

### package.json Scripts

The project includes scripts for:
- `render`: Generate HTML resumes
- `pdf`: Generate PDF resumes
- `build-all`: Generate both formats for all resumes
- `render-all`: Generate HTML for all resumes
- `pdf-all`: Generate PDF for all resumes
- `validate`: Validate JSON schema
- `watch`: Auto-rebuild on file changes

### GitHub Actions

The `.github/workflows/publish.yml` workflow:
1. Builds all resumes on push to main
2. Updates the Gist with the latest JSON data
3. Deploys HTML/PDF files to GitHub Pages
4. Optionally deploys to a custom github.io repository

## Project Structure

```
json-resume/
├── src/
│   ├── barista.json              # Barista resume data
│   ├── product-manager.json     # Product manager resume data
│   └── software-engineer.json   # Software engineer resume data
├── scripts/
│   ├── build.mjs                # Build and generate resumes
│   ├── validate.mjs             # Validate resume JSON
│   └── watch.mjs                # Watch and rebuild on changes
├── .github/workflows/publish.yml # CI/CD workflow
├── package.json                 # Project configuration
├── package-lock.json
└── .gitignore
```

## Data Management

### Gist Integration

The actual resume JSON data is stored in a GitHub Gist:
- Location: `gists/json-resume/`
- Files: `barista.json`, `product-manager.json`, `software-engineer.json`

The canonical URL in each JSON file points to this Gist:
```
"canonical": "https://gist.github.com/e597887d6598c25d2b880c079c6937fe"
```

This provides:
- Version control for resume data
- Easy backup and sharing
- Content integrity through GitHub's infrastructure

### Generating vs. Editing

**Use this repository for:**
- Building HTML/PDF resumes
- Running validation
- Testing different themes
- Working with the resume schema

**Use the Gist for:**
- Storing actual resume content
- Long-term data management
- Backup and version history

## Contributing

### Adding a New Resume Version

1. Add a new JSON file to the `src/` directory
2. Update the build workflow in `scripts/build.mjs` if needed
3. The GitHub Actions workflow will automatically handle the rest

### Updating an Existing Resume

1. Edit the JSON file in `src/`
2. Run validation to ensure it meets schema requirements:
   ```bash
   npm run validate <name>
   ```
3. Rebuild the resume:
   ```bash
   npm run render <name>
   ```
4. Or use watch mode for incremental testing:
   ```bash
   npm run watch <name>
   ```

## Support

This project uses the [JSON Resume Schema](https://jsonresume.org/) and the `resumed` CLI tool for generating resumes.

## License

This project is part of Ryan Wendell's personal portfolio and development tools.