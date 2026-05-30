import type { AutomationResponse, FillableElement } from '../types';

export const POLL_INTERVAL_MS = 250;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function stepDelay(ms?: number): Promise<void> {
  if (ms !== undefined) return delay(ms);
  return delay(350 + Math.floor(Math.random() * 250));
}

export async function waitFor<T>(
  factory: () => T | null | undefined | false,
  timeoutMs: number,
  intervalMs: number = POLL_INTERVAL_MS
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = factory();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error('Timed out waiting for page state');
}

export function successResponse(message: string): AutomationResponse {
  return {
    success: true,
    message,
    pageUrl: window.location.href,
    pageTitle: document.title,
    completedAt: new Date().toISOString()
  };
}

export function writeStatus(text: string): void {
  const existing = document.getElementById('token-automation-order-done');
  const banner = existing ?? document.createElement('div');
  banner.id = 'token-automation-order-done';
  banner.textContent = text;
  banner.setAttribute(
    'style',
    [
      'position: fixed',
      'right: 20px',
      'bottom: 20px',
      'z-index: 2147483647',
      'padding: 14px 18px',
      'border-radius: 12px',
      'background: #16a34a',
      'color: #ffffff',
      'font: 700 16px/1.3 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      'box-shadow: 0 16px 40px rgba(15, 23, 42, 0.24)'
    ].join(';')
  );
  if (!existing) document.documentElement.appendChild(banner);
}

export function visible(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
}

export function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

export function elementText(element: Element): string {
  return normalize((element as HTMLElement).innerText || element.textContent || '');
}

export function includesAny(value: string, terms: string[]): boolean {
  const normalized = normalize(value);
  return terms.some((term) => normalized.includes(normalize(term)));
}

export function visibleElements<T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector)).filter(visible);
}

export function enabled(element: HTMLElement): boolean {
  const ariaDisabled = element.getAttribute('aria-disabled') === 'true';
  const classDisabled = /\b(disabled|is-disabled|arco-btn-disabled)\b/i.test(element.className.toString());
  return !(element as HTMLButtonElement).disabled && !ariaDisabled && !classDisabled;
}

export function clickElement(element: HTMLElement): void {
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  element.click();
}

function setNativeValue(element: FillableElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
}

function dispatchFieldEvents(element: FillableElement, value: string, inputType: string, data?: string): void {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType, data: data ?? value }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.closest('.arco-input-wrapper, .arco-textarea-wrapper')?.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setFieldValue(element: FillableElement, value: string, options?: { blur?: boolean }): void {
  element.focus();
  setNativeValue(element, value);
  dispatchFieldEvents(element, value, 'insertFromPaste');
  if (options?.blur !== false) element.blur();
}

export function typeFieldValue(element: FillableElement, value: string): void {
  element.focus();
  setFieldValue(element, '', { blur: false });
  for (const character of value) {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: character, bubbles: true }));
    const nextValue = element.value + character;
    setNativeValue(element, nextValue);
    dispatchFieldEvents(element, nextValue, 'insertText', character);
    element.dispatchEvent(new KeyboardEvent('keyup', { key: character, bubbles: true }));
  }
  element.blur();
}

export function findButtonByText(terms: string[], root: ParentNode = document): HTMLElement | null {
  const buttons = visibleElements<HTMLElement>('button, [role="button"], a', root);
  const matches = buttons.filter((button) => enabled(button) && includesAny(elementText(button), terms));
  return (
    matches.find((button) => terms.some((term) => elementText(button) === normalize(term)) && button.tagName === 'BUTTON') ||
    matches.find((button) => /\b(arco-btn-primary|primary)\b/i.test(button.className.toString())) ||
    matches[0] ||
    null
  );
}

export async function clickButton(terms: string[], timeoutMs: number): Promise<boolean> {
  const button = await waitFor(() => findButtonByText(terms), timeoutMs);
  clickElement(button);
  await stepDelay();
  return true;
}

export async function retryStep<T>(
  label: string,
  action: () => Promise<T>,
  writeStatusFn: (text: string) => void,
  attempts = 4,
  verify?: () => boolean | Promise<boolean>
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await action();
      if (verify) {
        const verified = await verify();
        if (!verified) {
          throw new Error(`${label} did not complete`);
        }
      }
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        writeStatusFn(`${label} failed, retrying (${attempt}/${attempts})...`);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await delay(1500 * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}
