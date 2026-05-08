import { expect, test } from '@playwright/test';

test('planner loads and settings expose MCP configuration fields', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByText('Task Graph MCP URL')).toBeVisible();
  await expect(page.getByText('Supermemory MCP URL')).toBeVisible();
  await expect(page.getByText('Notion MCP URL')).toBeVisible();
});
