import { expect, test } from '@playwright/test';

test('app loads and shows the search UI', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/undergrowth/i);
});
