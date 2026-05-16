/**
 * Analytics configuration — single source of truth for GTM / GA4 / Google Ads IDs.
 *
 * Why this file exists:
 *   - One place to swap container/measurement IDs (e.g. for staging vs prod).
 *   - Same module is imported on both timrx.live and 3d.timrx.live so the
 *     anonymous identity follows the user via GA4's cross-subdomain cookie.
 *
 * NOTE: GTM_ID below is the production container. If you fork for staging,
 * swap it here and re-run the GTM rollout script (see docs/GTM_SETUP.md).
 */

// Public container/measurement IDs. None of these are secrets; they ship to the browser.
export const GTM_ID            = 'GTM-TH8DB6S5';        // TimrX production GTM container
export const GA4_MEASUREMENT_ID = 'G-K66VRX4FNS';      // documented only; GA4 is configured *inside* GTM
export const GOOGLE_ADS_ID     = 'AW-18162436469';     // documented only; Google Ads is configured *inside* GTM

// Real Google Ads conversion label for the "purchase" conversion action.
// GTM Google Ads conversion tag should set `Conversion ID` = AW-18162436469
// and `Conversion Label` = ruWaCPm54qwcEPWSw9RD. Stored here for documentation
// and so the legacy `gtag_report_conversion` helper (js/google-ads-conversions.js)
// stays in sync if anyone bypasses GTM.
export const GOOGLE_ADS_PURCHASE_LABEL = 'ruWaCPm54qwcEPWSw9RD';

// Cookie domain for cross-subdomain GA4 stitching (timrx.live ↔ 3d.timrx.live).
// Forwarded to the GA4 config tag inside GTM via a dataLayer variable.
export const ANALYTICS_COOKIE_DOMAIN = '.timrx.live';

// Set to `false` to short-circuit ALL dataLayer pushes (e.g. for an opt-out
// cookie banner choice). Default is true; consent UI can flip the flag at runtime
// via window.__TIMRX_ANALYTICS_OPT_IN__.
export const ANALYTICS_DEFAULT_OPT_IN = true;
