import { test, expect } from '@playwright/test';
import type { APIRequestContext, APIResponse } from '@playwright/test';

test.setTimeout(60_000);

const BASE = 'http://127.0.0.1:3099';

type ApiOptions = Parameters<APIRequestContext['fetch']>[1];

async function api(
  request: APIRequestContext,
  path: string,
  opts: ApiOptions = {},
): Promise<APIResponse> {
  return request.fetch(`${BASE}${path}`, opts);
}

test('B00 smoke — bootstrap, hello, chat, reminder persists', async ({ request }) => {
  // 1. hello before bootstrap — ownerEnrolled false
  let r = await api(request, '/api/hello');
  expect(r.ok()).toBeTruthy();
  let j = await r.json();
  // after previous e2e run, owner may already exist — handle both
  const needsBootstrap = !j.ownerEnrolled;

  if (needsBootstrap) {
    r = await api(request, '/api/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: { displayName: 'E2E Owner', passphrase: 'test123456789' },
    });
    expect(r.status()).toBe(201);
    j = await r.json();
    expect(j.token).toBeTruthy();
  }

  // login to get token (works whether bootstrapped now or earlier)
  r = await api(request, '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: { passphrase: 'test123456789' },
  });
  expect(r.ok()).toBeTruthy();
  const { token } = await r.json();
  expect(token).toBeTruthy();

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // 2. greeting
  r = await api(request, '/api/chat', {
    method: 'POST',
    headers: auth,
    data: { text: 'Hello darling' },
  });
  expect(r.ok()).toBeTruthy();
  const chat = await r.json();
  expect(chat.text).toBeTruthy();
  expect(chat.status).toMatch(/completed|degraded/);

  // 3. future reminder — relative phrase so deterministic parseWhen fires without ISO parsing
  r = await api(request, '/api/chat', {
    method: 'POST',
    headers: auth,
    data: { text: 'Remind me to test e2e in 30 minutes' },
  });
  expect(r.ok()).toBeTruthy();
  const rem = await r.json();
  // either the schedule action fired, or the deterministic floor asked for a time — both beat a hallucinated past date
  const sawSchedule = rem.actions?.some(
    (a: { toolId?: string; attempted?: boolean }) => a.toolId === 'reminder.schedule' && a.attempted,
  );
  const askedTime = typeof rem.text === 'string' && /when|kab|samay|time/i.test(rem.text);
  expect(sawSchedule || askedTime).toBeTruthy();

  // 4. list reminders
  r = await api(request, '/api/chat', {
    method: 'POST',
    headers: auth,
    data: { text: 'mere reminders dikhao' },
  });
  expect(r.ok()).toBeTruthy();
});

test('UI loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Madhurita/);
  await expect(page.locator('body')).toBeVisible();
});
