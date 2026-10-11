/**
 * Chromium launcher for the interop harness. Uses the preinstalled
 * Playwright Chromium build (never downloads browsers): playwright-core is
 * pinned to the release whose browsers.json names that build (1.56.1 →
 * chromium-1194 = Chromium 141.0.7390.37).
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';

export const CHROMIUM_PATH = process.env.HAXLITE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export function chromiumAvailable(): boolean {
  return existsSync(CHROMIUM_PATH);
}

export interface LaunchOptions {
  /** Extra Chromium flags. */
  args?: string[];
  /**
   * Disable mDNS obfuscation of host candidates (the browser then reveals its
   * IP like a page with camera permission). Default false = what real users send.
   */
  revealHostIps?: boolean;
}

export async function launchChromium(o: LaunchOptions = {}): Promise<Browser> {
  const args = [...(o.args ?? [])];
  if (o.revealHostIps) args.push('--disable-features=WebRtcHideLocalIpsWithMdns');
  return chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args });
}

/** Opens the harness page of `serverUrl` and waits for `window.hx`. */
export async function openHarnessPage(browser: Browser, serverUrl: string): Promise<Page> {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(serverUrl + '/');
  await page.waitForFunction(() => (globalThis as unknown as { hxReady?: boolean }).hxReady === true);
  return page;
}

export async function chromiumVersion(browser: Browser): Promise<string> {
  return browser.version();
}
