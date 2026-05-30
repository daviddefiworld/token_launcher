export const TOKEN_AUTOMATION_PORT = 'tokenAutomation';

export const RUNTIME_MSG = {
  progress: 'tokenAutomationProgress',
  result: 'tokenAutomationResult'
} as const;

export interface TokenAutomationMessage {
  type?: string;
  orderId?: string;
  text?: string;
  currency?: string;
  chain?: string;
  address?: string;
  amount?: string;
  emailCode?: string;
  authenticatorCode?: string;
  emailCodeSentAt?: number;
}

export interface AutomationResponse {
  success: boolean;
  message?: string;
  pageUrl?: string;
  pageTitle?: string;
  completedAt?: string;
  error?: string;
  verificationRequired?: boolean;
  emailCodeSent?: boolean;
  emailCodeSentAt?: number;
  emailCode?: string;
}

export interface AutomationProgressMessage {
  type: typeof RUNTIME_MSG.progress;
  orderId: string;
  message?: string;
}

export interface AutomationResultMessage {
  type: typeof RUNTIME_MSG.result;
  orderId: string;
  ok: boolean;
  response: AutomationResponse;
}

export type FillableElement = HTMLInputElement | HTMLTextAreaElement;
