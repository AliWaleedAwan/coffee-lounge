import { readFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export interface ShopState {
  owner: { username: string; password: string };
  staff: { username: string; name: string; role: string; pin: string }[];
  password: string;
  codes: string[];
}

/** Test users and one-time codes written by the e2e server (git-ignored). */
export function shop(): ShopState {
  return JSON.parse(
    readFileSync(new URL('../.e2e/state.json', import.meta.url), 'utf8'),
  ) as ShopState;
}

/** AT-86: no serious or critical WCAG 2.1 A/AA violations on the screen. */
export async function expectAccessible(page: Page, screen: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(serious, `accessibility of ${screen}`).toEqual([]);
}

export async function registerDevice(page: Page, code: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Register this device' })).toBeVisible();
  await page.getByLabel('Registration code').fill(code);
  await page.getByRole('button', { name: 'Register device' }).click();
  await expect(page.getByRole('heading', { name: 'Log in' })).toBeVisible();
}

export async function logIn(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

export async function navLabels(page: Page): Promise<string[]> {
  return page.getByRole('navigation', { name: 'Main' }).getByRole('link').allTextContents();
}
