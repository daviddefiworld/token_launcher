import type { AutomationResponse } from '../../types';

export function successResponse(message: string): AutomationResponse {
  return {
    success: true,
    message,
    pageUrl: window.location.href,
    pageTitle: document.title,
    completedAt: new Date().toISOString()
  };
}
