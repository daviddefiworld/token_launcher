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

  if (!existing) {
    document.documentElement.appendChild(banner);
  }
}
