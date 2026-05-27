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

export type FillableElement = HTMLInputElement | HTMLTextAreaElement;
