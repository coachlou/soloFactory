// Token shapes for API keys and bearer credentials. feedback.mjs scrubs them out of reports, and the factory's secrets
// gate fails a run that commits one. A module of its own so factory.mjs and feedback.mjs (which imports factory.mjs)
// can both use it without a circular import. Global regexes for replace(); build non-global copies before .test().
export const CREDENTIAL_PATTERNS = Object.freeze([
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abp]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{12,})\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
]);
