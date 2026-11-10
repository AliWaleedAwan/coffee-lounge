/** Mistakes in the setup scripts that the Windows drills cannot reach. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(new URL(`../../../deploy/windows/${name}`, import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

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

describe('the wizard and an existing PostgreSQL 17', () => {
  it('checks the password before installing, and offers our own database instead', () => {
    const nsi = read('installer.nsi');
    expect(nsi).toContain('check-postgres-password.ps1');
    expect(nsi).toContain('CL_PG_MODE');
    expect(nsi).toContain('reset-postgres-password.html');
    expect(read('install.ps1')).toContain("$env:CL_PG_MODE -eq 'own'");
  });

  it('reads the install result straight after the install, before anything else', () => {
    expect(read('installer.nsi')).toMatch(
      /ExecToLog '\$R1 -Unattended -Wizard -ShopIp "\$ShopIp"'\n\s*;[^\n]*\n\s*Pop \$0/,
    );
  });

  it('the reset guide always restores the login settings', () => {
    const guide = read('reset-postgres-password.html');
    expect(guide.indexOf('pg_hba.conf.bak" "C:')).toBeGreaterThan(guide.indexOf('trust'));
  });
});

describe('whatever the PC', () => {
  it('the scripts restore the Windows folders to PATH before using any Windows tool', () => {
    const lib = read('lib.ps1');
    expect(lib.indexOf('$env:Path =')).toBeGreaterThan(-1);
    expect(lib.indexOf('$env:Path =')).toBeLessThan(lib.indexOf('function '));
  });

  it('accounts are named by fixed ID, never by a name Windows translates', () => {
    for (const name of ['install.ps1', 'lib.ps1', 'restore.ps1']) {
      expect(read(name), name).not.toMatch(/'NT AUTHORITY\\NETWORK SERVICE/);
    }
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
