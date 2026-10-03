import { execFileSync } from 'node:child_process';

// Check the Git index, not untracked local files. Never print matching secrets.
const git = (...args) => execFileSync('git', args, { maxBuffer: 20 * 1024 * 1024 });
const exact = new Set([
  '.gitignore', '.gitattributes', 'README.md', 'index.html',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
  '.github/workflows/pages.yml', 'tools/check-repository.mjs',
  'public/audio/manifest.json', 'public/audio/hall.m4a',
  'public/audio/stepwell.m4a', 'public/audio/summit.m4a',
  'public/audio/sfx/bottom.m4a', 'public/audio/sfx/stop.m4a',
  'public/models/arch.glb', 'public/models/cabin.glb', 'public/models/stepwell.glb',
  'public/textures/stone_detail.jpg', 'public/textures/stone_normal.jpg',
  'public/video/intro.mp4',
]);
const allowed = (name) => exact.has(name)
  || /^src\/(?:[\w-]+\/)*[\w-]+\.(?:ts|css)$/.test(name)
  || /^tests\/(?:[\w-]+\/)*[\w.-]+\.mjs$/.test(name);
const sensitiveName = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.netrc$)|(?:secret|credential)|\.(?:pem|key|p12|pfx)$/i;
const signatures = [
  ['private key', /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ['API token', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['credential in URL', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ['literal credential', /\b(?:password|api[_-]?key|client[_-]?secret|access[_-]?token)\s*[:=]\s*["'][^"'\r\n]{12,}["']/i],
  ['local user path', /(?:[A-Z]:[\\/]+Users[\\/]+|\/(?:Users|home)\/)[A-Za-z0-9_.-]+/i],
];

const entries = git('ls-files', '--stage', '-z').toString('utf8').split('\0').filter(Boolean);
if (!entries.length) throw new Error('No tracked files. Stage the intended publication files first.');
const errors = [];
for (const entry of entries) {
  const [header, name] = entry.split('\t');
  const [mode, hash, stage] = header.split(' ');
  if (!allowed(name) || sensitiveName.test(name)) errors.push(`${name}: file is outside the publication allowlist`);
  if (mode !== '100644' && mode !== '100755') errors.push(`${name}: symlinks and submodules are not allowed`);
  if (stage !== '0') errors.push(`${name}: unresolved merge conflict`);
  const content = git('cat-file', 'blob', hash).toString('utf8');
  for (const [label, pattern] of signatures) {
    if (pattern.test(content)) errors.push(`${name}: possible ${label}`);
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${entries.length} tracked files: allowed paths, no detected credential signatures or local user paths.`);
}
