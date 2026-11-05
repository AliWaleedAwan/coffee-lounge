/** Mistakes in the setup scripts that the Windows drills cannot reach. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(new URL(`../../../deploy/windows/${name}`, import.meta.url), 'utf8');

describe('the setup scripts', () => {
  it('never Join-Path the backup drive: it fails while the drive is not plugged in', () => {
    expect(read('install.ps1')).not.toMatch(/Join-Path\s+\$BackupDrive/);
  });

  it('the wizard never quotes the USB folder on a command line ("E:\\" breaks it)', () => {
    expect(read('installer.nsi')).not.toMatch(/-CaExportDir "\$KeyDir"/);
    expect(read('install.ps1')).toContain('$env:CL_CA_EXPORT_DIR');
  });

  it('only a finished install counts as an upgrade', () => {
    expect(read('installer.nsi')).not.toMatch(/PG_VERSION/);
  });
});

describe('PostgreSQL already on the PC', () => {
  it('no script names the database service or port itself: all follow database.json', () => {
    for (const name of ['install.ps1', 'uninstall.ps1', 'restore.ps1', 'watchdog.ps1']) {
      const text = read(name).replace(/^\s*#.*$/gm, '');
      const fixed = text
        .split('\n')
        .filter(
          (l) =>
            l.includes("'postgresql-x64-17'") && !l.includes('Mode =') && !l.includes('$name = '),
        );
      expect(fixed, name).toEqual([]);
    }
    expect(read('services/coffeelounge-api.xml')).toContain('{{PG_SERVICE}}');
  });

  it('a point-in-time restore refuses on a shared PostgreSQL', () => {
    expect(read('restore.ps1')).toMatch(/Mode -eq 'shared'\) \{\s*throw/);
  });
});

describe('the icon', () => {
  it('is a real Windows icon with the sizes the desktop uses', () => {
    const ico = readFileSync(new URL('../assets/icon.ico', import.meta.url));
    expect(ico.readUInt16LE(2)).toBe(1);
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico[6 + 16 * i] || 256);
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 256]));
  });
});
