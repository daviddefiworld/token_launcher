import type { FillableElement } from '../../types';
import { delay, stepDelay, waitFor } from './timing';

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
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
}

function dispatchFieldEvents(element: FillableElement, value: string, inputType: string, data?: string): void {
  element.dispatchEvent(
    new InputEvent('input', { bubbles: true, composed: true, inputType, data: data ?? value })
  );
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.closest('.arco-input-wrapper, .arco-textarea-wrapper')?.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setFieldValue(element: FillableElement, value: string, options?: { blur?: boolean }): void {
  element.focus();
  setNativeValue(element, value);
  dispatchFieldEvents(element, value, 'insertFromPaste');
  if (options?.blur !== false) {
    element.blur();
  }
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

export function setEditableValue(element: HTMLElement, value: string): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    setFieldValue(element, value);
    return;
  }
  element.focus();
  element.textContent = value;
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
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

export async function retryStep<T>(label: string, action: () => Promise<T>, writeStatusFn: (text: string) => void, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        writeStatusFn(`${label} failed, retrying (${attempt}/${attempts})...`);
        await delay(1500 * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}
