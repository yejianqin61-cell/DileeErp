import { expect, test } from "playwright/test";

test("authentication.anonymous_business_page_redirects_to_login", async ({ page }) => {
  await page.goto("/customers");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
});

test("authentication.invalid_credentials_show_a_user_visible_error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("invalid-test-user");
  await page.getByLabel("密码").fill("InvalidPassword2026");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("用户名或密码错误")).toBeVisible();
});
