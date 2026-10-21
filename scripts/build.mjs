import { execSync } from 'child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const command = process.argv[2];
const file = process.argv[3];
const theme = process.argv[4];

if (!command) {
  console.error('Usage: node scripts/build.mjs <render|pdf|render-all|pdf-all|build-all> [resume] [theme]');
  console.error('  e.g.: node scripts/build.mjs pdf barista');
  console.error('  e.g.: node scripts/build.mjs render barista jsonresume-theme-even');
  console.error('  e.g.: node scripts/build.mjs build-all');
  process.exit(1);
}

function resolveFile(file) {
  const name = file.endsWith('.json') ? file : `${file}.json`;
  if (name.includes('/')) return name;
  return `src/${name}`;
}

function buildOne(cmd, file, theme) {
  const base = basename(file, '.json');
  const src = resolve(rootDir, file);
  const outDir = resolve(rootDir, 'dist', base);
  const ext = cmd === 'pdf' ? 'pdf' : 'html';
  const out = resolve(outDir, `${base}.${ext}`);
  const themeFlag = theme ? `-t ${theme}` : '';

  mkdirSync(outDir, { recursive: true });

  const shell = cmd === 'pdf'
    ? `npx resumed export "${src}" -o "${out}" ${themeFlag} --puppeteer-arg=--no-sandbox`
    : `npx resumed render "${src}" -o "${out}" ${themeFlag}`;

  console.log(`${cmd}: ${file} -> dist/${base}/${base}.${ext}`);
  execSync(shell, { cwd: rootDir, stdio: 'inherit' });
}

function getAllResumes() {
  return readdirSync(resolve(rootDir, 'src'))
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => `src/${f}`);
}

function generateIndex(resumes) {
  const metadata = resumes.map(file => {
    const data = JSON.parse(readFileSync(resolve(rootDir, file), 'utf8'));
    const id = basename(file, '.json');
    return { id, label: data.basics?.label || data.basics?.name || id };
  });
  const defaultResume = metadata[0]?.id || '';
  const resumeData = JSON.stringify(metadata);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ryan Wendell</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; }
    nav { display: flex; align-items: center; border-bottom: 2px solid #e0e0e0; padding: 0 2rem; }
    nav button { padding: .75rem 1.5rem; border: none; background: transparent; cursor: pointer; font-size: 1rem; color: #666; border-bottom: 2px solid transparent; margin-bottom: -2px; }
    nav button:hover { color: #333; }
    nav button.active { color: #1a1a1a; border-bottom-color: #1a1a1a; font-weight: 600; }
    .download-btn { margin-left: auto; padding: .5rem 1rem; border: 1px solid #e0e0e0; background: white; cursor: pointer; font-size: .9rem; border-radius: 4px; text-decoration: none; color: #333; }
    .download-btn.hidden { display: none; }
    iframe { width: 100%; border: none; height: calc(100vh - 50px); }
  </style>
</head>
<body>
  <nav id="nav"><a id="download" class="download-btn hidden" download>Download PDF</a></nav>
  <iframe id="frame"></iframe>
  <script>
    const resumes = ${resumeData};
    const defaultResume = ${JSON.stringify(defaultResume)};
    const frame = document.getElementById('frame');
    const nav = document.getElementById('nav');
    const downloadBtn = document.getElementById('download');
    function load(id) {
      const resume = resumes.find(item => item.id === id) || resumes[0];
      if (!resume) return;
      frame.src = 'pages/' + resume.id + '.html';
      location.hash = resume.id;
      document.querySelectorAll('nav button').forEach(button => button.classList.toggle('active', button.dataset.resume === resume.id));
      downloadBtn.href = 'pdf/' + resume.id + '.pdf';
      downloadBtn.download = resume.id + '.pdf';
      downloadBtn.classList.remove('hidden');
    }
    resumes.forEach(resume => {
      const button = document.createElement('button');
      button.textContent = resume.label;
      button.dataset.resume = resume.id;
      button.onclick = () => load(resume.id);
      nav.insertBefore(button, downloadBtn);
    });
    load(location.hash.slice(1) || defaultResume);
  </script>
</body>
</html>
`;
  writeFileSync(resolve(rootDir, 'dist', 'index.html'), html);
  console.log(`index: generated for ${metadata.length} resume(s)`);
}

if (command.endsWith('-all')) {
  const cmd = command.replace('-all', '') || 'render';
  const resumes = getAllResumes();
  for (const r of resumes) {
    if (cmd === 'pdf' || command === 'build-all') buildOne('pdf', r, theme);
    if (cmd === 'render' || command === 'build-all') buildOne('render', r, theme);
  }
  if (command === 'build-all') generateIndex(resumes);
} else {
  if (!file) {
    console.error('Usage: node scripts/build.mjs <render|pdf> <resume> [theme]');
    process.exit(1);
  }
  buildOne(command, resolveFile(file), theme);
}
