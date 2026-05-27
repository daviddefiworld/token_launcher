import type { AutomationResponse, FillableElement, TokenAutomationMessage } from '../../types';
import {
  clickElement,
  elementText,
  enabled,
  findButtonByText,
  includesAny,
  normalize,
  retryStep,
  setFieldValue,
  typeFieldValue,
  visibleElements
} from '../shared/dom';
import { delay, stepDelay, waitFor } from '../shared/timing';
import { successResponse } from '../shared/response';
import { writeStatus } from '../shared/status';
import { BITUNIX_HOST, WAIT, WITHDRAW_PATH } from './constants';

function findSymbolSelectWrapper(): HTMLElement | null {
  return visibleElements<HTMLElement>('.symbol-select-wrapper')[0] || null;
}

function isCoinSelected(currency: string): boolean {
  const wrapper = findSymbolSelectWrapper();
  if (!wrapper) return false;
  const normalizedCurrency = normalize(currency);
  const hotActive = visibleElements<HTMLElement>('.hot_currency_btn', wrapper).find(
    (button) => elementText(button) === normalizedCurrency && /\bactive\b/i.test(button.className.toString())
  );
  if (hotActive) return true;

  const searchInput = wrapper.querySelector<HTMLInputElement>('input.arco-select-view-input');
  if (searchInput?.value && normalize(searchInput.value) === normalizedCurrency) {
    return true;
  }

  const selectedValue = wrapper.querySelector('.arco-select-view-value');
  if (selectedValue && !selectedValue.classList.contains('arco-select-view-value-hidden')) {
    return includesAny(elementText(selectedValue), [currency]);
  }

  return includesAny(elementText(wrapper), [currency]);
}

async function waitForCoinSelected(currency: string): Promise<void> {
  await waitFor(() => isCoinSelected(currency) || Boolean(findNetworkSearchInput()), WAIT.long);
  await stepDelay();
}

function findCoinHotButton(currency: string): HTMLElement | null {
  const wrapper = findSymbolSelectWrapper();
  if (!wrapper) return null;
  const normalizedCurrency = normalize(currency);
  return (
    visibleElements<HTMLElement>('.hot_currency_btn', wrapper).find((button) => elementText(button) === normalizedCurrency) ||
    null
  );
}

function findCoinSearchInput(): HTMLInputElement | null {
  const wrapper = findSymbolSelectWrapper();
  if (!wrapper) return null;
  return wrapper.querySelector<HTMLInputElement>('input.arco-select-view-input[placeholder*="coin" i]');
}

function findCoinOptionInDropdown(currency: string): HTMLElement | null {
  const normalizedCurrency = normalize(currency);
  const options = visibleElements<HTMLElement>(
    '.arco-select-dropdown .arco-select-option, .arco-trigger-popup .arco-select-option, .log_body_item'
  );
  return (
    options.find((option) => elementText(option.querySelector('.coin_name') || option) === normalizedCurrency) ||
    options.find((option) => elementText(option) === normalizedCurrency) ||
    options.find((option) => includesAny(elementText(option), [currency])) ||
    null
  );
}

async function openCoinDropdown(): Promise<HTMLInputElement> {
  const input = await waitFor(() => findCoinSearchInput(), WAIT.medium);
  clickElement(input);
  await stepDelay();
  return input;
}

async function selectCoin(currency: string): Promise<void> {
  await stepDelay();
  const hotButton = findCoinHotButton(currency);
  if (hotButton) {
    clickElement(hotButton);
    await waitForCoinSelected(currency);
    return;
  }

  const input = await openCoinDropdown();
  setFieldValue(input, currency);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await stepDelay();

  const option = await waitFor(() => findCoinOptionInDropdown(currency), WAIT.long);
  clickElement(option);
  await waitForCoinSelected(currency);
}

function findNetworkSection(): ParentNode {
  return document.querySelector('#net') || visibleElements<HTMLElement>('.form_item').find((item) => includesAny(elementText(item), ['network'])) || document;
}

function findNetworkSearchInput(): HTMLInputElement | null {
  const section = findNetworkSection();
  return section.querySelector<HTMLInputElement>('input.arco-select-view-input[placeholder*="network" i]');
}

function findChainOptions(): HTMLElement[] {
  return visibleElements<HTMLElement>(
    '.arco-select-dropdown .arco-select-option, .arco-trigger-popup .arco-select-option, .arco-select-dropdown .log_body_item'
  );
}

async function openNetworkDropdown(): Promise<HTMLInputElement> {
  const input = await waitFor(() => findNetworkSearchInput(), WAIT.medium);
  clickElement(input);
  await stepDelay();
  return input;
}

async function waitForChainListVisible(): Promise<HTMLElement[]> {
  await openNetworkDropdown();
  const options = await waitFor(() => {
    const visibleOptions = findChainOptions();
    return visibleOptions.length > 0 ? visibleOptions : null;
  }, WAIT.long);
  return options;
}

function findChainOption(chain: string, options: HTMLElement[]): HTMLElement | null {
  const normalizedChain = normalize(chain);
  return (
    options.find((option) => elementText(option) === normalizedChain) ||
    options.find((option) => elementText(option).includes(normalizedChain)) ||
    null
  );
}

async function selectChain(chain: string, currency: string): Promise<void> {
  await stepDelay();
  let lastError: unknown;

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const options = await waitForChainListVisible();
      const option = findChainOption(chain, options);
      if (!option) {
        throw new Error(`Network option "${chain}" is not available yet`);
      }
      clickElement(option);
      await stepDelay();
      return;
    } catch (error) {
      lastError = error;
      writeStatus(`Waiting for network list (${attempt}/6)...`);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay(1200 * attempt);

      if (attempt % 2 === 0) {
        await selectCoin(currency);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Could not select network "${chain}"`);
}

function findWithdrawAddressTextarea(): HTMLTextAreaElement | null {
  const selectors = [
    'textarea.arco-textarea[placeholder*="withdrawal address" i]',
    'textarea.arco-textarea[placeholder="Enter withdrawal address"]',
    '.withdraw-address-wrapper textarea.arco-textarea',
    '.address-form-wrapper textarea.arco-textarea'
  ];

  for (const selector of selectors) {
    const textarea = visibleElements<HTMLTextAreaElement>(selector).find(
      (element) => !element.closest('.arco-modal, .arco-modal-wrapper, [role="dialog"]')
    );
    if (textarea) return textarea;
  }

  return null;
}

async function fillWithdrawAddress(value: string): Promise<void> {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await stepDelay();

  const textarea = await waitFor(() => findWithdrawAddressTextarea(), WAIT.medium);
  clickElement(textarea);
  setFieldValue(textarea, value, { blur: false });
  await stepDelay();

  if (textarea.value.trim() !== value.trim()) {
    typeFieldValue(textarea, value);
    await stepDelay();
  }

  if (textarea.value.trim() !== value.trim()) {
    throw new Error('Withdrawal address was not accepted by the form');
  }

  textarea.blur();
  await stepDelay();
}

function findWithdrawAmountInput(): HTMLInputElement | null {
  const selectors = [
    '#assets-withdraw-step4 .money_input input.arco-input:not([disabled])',
    '#numberValue .money_input input.arco-input:not([disabled])',
    '.form_item .money_input input.arco-input:not([disabled])'
  ];

  for (const selector of selectors) {
    const input = visibleElements<HTMLInputElement>(selector).find(
      (element) => !element.closest('.arco-modal, .arco-modal-wrapper, [role="dialog"], .faq-box')
    );
    if (input) return input;
  }

  return null;
}

async function fillAmount(value: string): Promise<void> {
  await stepDelay();
  const input = await waitFor(() => findWithdrawAmountInput(), WAIT.medium);
  clickElement(input);
  setFieldValue(input, value, { blur: false });
  await stepDelay();

  if (input.value.trim() !== value.trim()) {
    typeFieldValue(input, value);
    await stepDelay();
  }

  if (input.value.trim() !== value.trim()) {
    throw new Error('Withdrawal amount was not accepted by the form');
  }

  input.blur();
  await stepDelay();
}

function findWithdrawSubmitButton(): HTMLButtonElement | null {
  return (
    visibleElements<HTMLButtonElement>('button.arco-btn-primary').find(
      (button) =>
        !button.closest('.faq-box') &&
        elementText(button) === 'withdraw' &&
        enabled(button)
    ) || null
  );
}

async function clickWithdrawSubmit(): Promise<boolean> {
  const button = await waitFor(() => findWithdrawSubmitButton(), WAIT.medium);
  clickElement(button);
  await stepDelay();
  return true;
}

function findDialogRoot(): ParentNode {
  return (
    visibleElements<HTMLElement>(
      '[role="dialog"], .arco-modal, .arco-modal-wrapper, .authentication-modal, .deposit-withdraw-detail-modal'
    )[0] || document
  );
}

function findVerificationDialogRoot(): HTMLElement | null {
  for (const root of visibleElements<HTMLElement>('.security_verification, .arco-modal, .arco-modal-wrapper, [role="dialog"]')) {
    if (findVerificationInput('email', root) && findVerificationInput('google', root)) {
      return root;
    }
  }
  return null;
}

function verificationCodesMatch(
  root: ParentNode,
  emailCode: string,
  authenticatorCode: string
): boolean {
  const emailInput = findVerificationInput('email', root);
  const googleInput = findVerificationInput('google', root);
  return emailInput?.value === emailCode && googleInput?.value === authenticatorCode;
}

async function fillVerificationField(input: HTMLInputElement, code: string): Promise<void> {
  setFieldValue(input, code, { blur: false });
  await stepDelay();
  if (input.value === code) return;

  typeFieldValue(input, code);
  await stepDelay();
  if (input.value === code) return;

  setFieldValue(input, code);
}

function verificationInputs(root: ParentNode = findDialogRoot()): FillableElement[] {
  return visibleElements<FillableElement>('input:not([disabled]), textarea:not([disabled])', root).filter((input) => {
    const text = normalize(
      [
        input.getAttribute('aria-label'),
        input.getAttribute('placeholder'),
        input.getAttribute('name'),
        input.getAttribute('id')
      ]
        .filter(Boolean)
        .join(' ')
    );
    return (
      text.includes('code') ||
      text.includes('verification') ||
      text.includes('auth') ||
      text.includes('mail') ||
      text.includes('google') ||
      (input instanceof HTMLInputElement && input.maxLength > 0 && input.maxLength <= 8)
    );
  });
}

function findVerificationInput(sectionId: 'email' | 'google', root: ParentNode = findDialogRoot()): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(`#${sectionId} input.arco-input:not([disabled])`);
}

function findVerificationSubmitButton(root: ParentNode): HTMLButtonElement | null {
  const scope = (root instanceof HTMLElement && root.classList.contains('security_verification') ? root : root.querySelector('.security_verification')) || root;
  const buttons = visibleElements<HTMLButtonElement>('button.arco-btn-primary', scope);
  return buttons.find((button) => includesAny(elementText(button), ['Submit']) && enabled(button)) || null;
}

async function fillVerificationCodes(emailCode: string, authenticatorCode: string): Promise<void> {
  await stepDelay();
  const root = await waitFor(() => findVerificationDialogRoot(), WAIT.medium);
  const emailInput = await waitFor(() => findVerificationInput('email', root), WAIT.medium);
  const googleInput = await waitFor(() => findVerificationInput('google', root), WAIT.medium);

  await fillVerificationField(emailInput, emailCode);
  await fillVerificationField(googleInput, authenticatorCode);

  if (!verificationCodesMatch(root, emailCode, authenticatorCode)) {
    const inputs = verificationInputs(root);
    if (inputs.length >= 12 && inputs.every((input) => input instanceof HTMLInputElement && input.maxLength === 1)) {
      emailCode.split('').forEach((character, index) => setFieldValue(inputs[index], character, { blur: false }));
      authenticatorCode.split('').forEach((character, index) => setFieldValue(inputs[index + 6], character, { blur: false }));
    } else if (inputs[0]) {
      await fillVerificationField(inputs[0] as HTMLInputElement, emailCode);
      if (inputs[1]) await fillVerificationField(inputs[1] as HTMLInputElement, authenticatorCode);
    }
  }

  emailInput.blur();
  googleInput.blur();
  await stepDelay();

  await waitFor(() => (verificationCodesMatch(root, emailCode, authenticatorCode) ? true : null), WAIT.medium);
  await waitFor(() => findVerificationSubmitButton(root), WAIT.medium);
}

async function clickVerificationSubmit(): Promise<boolean> {
  const root = await waitFor(() => findVerificationDialogRoot(), WAIT.medium);
  const submitButton = await waitFor(() => findVerificationSubmitButton(root), WAIT.medium);
  clickElement(submitButton);
  await stepDelay();
  return true;
}

function assertWithdrawRequest(message: TokenAutomationMessage): Required<Pick<TokenAutomationMessage, 'currency' | 'chain' | 'address' | 'amount'>> {
  const currency = message.currency?.trim();
  const chain = message.chain?.trim();
  const address = message.address?.trim();
  const amount = message.amount?.trim();

  if (!currency) throw new Error('currency is required');
  if (!chain) throw new Error('chain is required');
  if (!address) throw new Error('address is required');
  if (!amount) throw new Error('amount is required');
  return { currency, chain, address, amount };
}

function assertBitunixWithdrawPage(): void {
  if (window.location.hostname !== BITUNIX_HOST || !window.location.pathname.startsWith(WITHDRAW_PATH)) {
    throw new Error('Open the Bitunix withdraw page before running this skill');
  }
  if (/\/login/i.test(window.location.pathname) || includesAny(document.body.innerText || '', ['log in to continue'])) {
    throw new Error('Bitunix is not logged in. Please log in and run the order again.');
  }
}

async function clickVerificationGetCode(): Promise<number> {
  await stepDelay();
  const button = await waitFor(
    () => visibleElements<HTMLElement>('.get_code_btn')[0] || findButtonByText(['Get code', 'Send code'], findVerificationDialogRoot() || findDialogRoot()),
    WAIT.medium
  );
  clickElement(button);
  await stepDelay();
  return Date.now();
}

export async function submitVerification(message: TokenAutomationMessage): Promise<AutomationResponse> {
  const emailCode = message.emailCode?.trim();
  const authenticatorCode = message.authenticatorCode?.trim();
  if (!emailCode) throw new Error('emailCode is required for verification');
  if (!authenticatorCode) throw new Error('authenticatorCode is required for verification');

  await retryStep('Fill verification codes', () => fillVerificationCodes(emailCode, authenticatorCode), writeStatus);
  await retryStep('Submit verification', clickVerificationSubmit, writeStatus);
  writeStatus('Bitunix withdraw verification submitted');
  return successResponse('Bitunix withdraw verification submitted');
}

export async function runWithdraw(message: TokenAutomationMessage): Promise<AutomationResponse> {
  const request = assertWithdrawRequest(message);
  assertBitunixWithdrawPage();
  writeStatus('Filling Bitunix withdraw form...');

  await waitFor(() => document.readyState === 'complete' || document.readyState === 'interactive', WAIT.medium);
  await waitFor(() => document.body && document.body.innerText.length > 100, WAIT.long);
  await stepDelay();

  await retryStep('Select coin', () => selectCoin(request.currency), writeStatus);
  await retryStep('Select network', () => selectChain(request.chain, request.currency), writeStatus);
  await retryStep('Fill withdrawal address', () => fillWithdrawAddress(request.address), writeStatus);
  await retryStep('Fill withdrawal amount', () => fillAmount(request.amount), writeStatus);
  await retryStep('Submit withdraw form', clickWithdrawSubmit, writeStatus);

  const confirmButton = await waitFor(() => findButtonByText(['Confirm', 'OK', 'Continue']), WAIT.short).catch(() => null);
  if (confirmButton) {
    clickElement(confirmButton);
    await stepDelay();
  }

  const verificationVisible = await waitFor(
    () => verificationInputs().length > 0 || visibleElements<HTMLElement>('.get_code_btn')[0],
    WAIT.long
  ).catch(() => false);

  if (verificationVisible) {
    const emailCodeSentAt = await retryStep('Request email code', clickVerificationGetCode, writeStatus).catch(() => 0);
    if (message.emailCode?.trim() && message.authenticatorCode?.trim()) {
      return submitVerification(message);
    }

    writeStatus('Email code requested. Waiting for backend Gmail lookup...');
    return {
      ...successResponse('Bitunix withdraw submitted. Waiting for email verification code.'),
      verificationRequired: true,
      emailCodeSent: emailCodeSentAt > 0,
      emailCodeSentAt: emailCodeSentAt || Date.now()
    };
  }

  writeStatus('Bitunix withdraw submitted');
  return successResponse('Bitunix withdraw submitted');
}
