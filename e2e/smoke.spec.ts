import { test, expect } from "@playwright/test";

const TOKEN = process.env.EASYMODE_ACCESS_TOKEN!;

test("API refuses chat without the access token", async ({ request }) => {
  const body = { messages: [{ id: "1", role: "user", parts: [{ type: "text", text: "hi" }] }] };
  const anon = await request.post("/api/chat", { data: body });
  expect(anon.status()).toBe(401);
  const wrong = await request.post("/api/chat", {
    data: body,
    headers: { authorization: "Bearer not-the-token" },
  });
  expect(wrong.status()).toBe(401);
  const login = await request.post("/api/auth", { data: { token: "not-the-token" } });
  expect(login.status()).toBe(401);
});

test("trivial message routes cheap, reveal opens, savings accumulate", async ({ page }) => {
  await page.goto("/");
  // Unlock with the access token; the session cookie survives the reload below.
  await page.getByLabel("Access token").fill(TOKEN);
  await page.getByRole("button", { name: "Unlock" }).click();
  const box = page.getByPlaceholder(/ask anything/i);

  // 1. Trivial message → cheap model chip.
  await box.fill("hi");
  await box.press("Enter");
  const chip = page.locator("button:has-text('how?')").first();
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await expect(chip).toContainText(/Haiku 4.5|Sonnet 5/);

  // 2. Reveal panel shows optimized prompt + cost table with Router line.
  await chip.click();
  await expect(page.getByText("Your prompt → optimized")).toBeVisible();
  await expect(page.getByText("Router (Haiku)")).toBeVisible();

  // 3. Conversation savings total appears in header.
  await expect(page.locator("header")).toContainText(/vs always-Opus/, { timeout: 60_000 });

  // 4. Persistence: reload keeps the message. Target the message bubble by
  // testid — the sidebar auto-titles the conversation "hi" too.
  await page.reload();
  await expect(page.getByTestId("user-bubble").filter({ hasText: /^hi$/ })).toBeVisible();
});
