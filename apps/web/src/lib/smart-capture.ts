/**
 * Hand-off between Smart Capture and the AI Scanner: a captured JPEG data URL
 * is parked in sessionStorage under this key and consumed once by the scanner.
 */
export const PENDING_SCAN_KEY = 'smart-capture:pending-scan';
