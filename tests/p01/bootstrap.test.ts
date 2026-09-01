import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Phase P01: Bootstrap Requirements', () => {
  const root = path.resolve(__dirname, '../../');

  it('has package.json with necessary scripts', () => {
    const pkgPath = path.join(root, 'package.json');
    expect(fs.existsSync(pkgPath)).toBe(true);

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.scripts?.lint).toBeDefined();
    expect(pkg.scripts?.typecheck).toBeDefined();
    expect(pkg.scripts?.test).toBeDefined();
  });

  const requiredConfig = [
    'tsconfig.json',
    'eslint.config.js',
    '.prettierrc.json',
    '.editorconfig',
    '.gitignore',
    '.nvmrc',
    'vite.config.ts',
    'vitest.config.ts',
  ];

  for (const config of requiredConfig) {
    it(`has ${config}`, () => {
      expect(fs.existsSync(path.join(root, config))).toBe(true);
    });
  }

  const requiredDirectories = [
    'scripts',
    '.github/workflows',
    'server/persistence',
    'server/identity',
    'server/authz',
    'server/memory',
    'server/events',
    'server/cognition',
    'server/actions',
    'server/tasks',
    'server/learning',
    'server/proactivity',
    'server/voice',
    'server/realtime',
    'src/components',
    'tests',
  ];

  for (const dir of requiredDirectories) {
    it(`has directory ${dir}`, () => {
      const stats = fs.statSync(path.join(root, dir));
      expect(stats.isDirectory()).toBe(true);
    });
  }
});
