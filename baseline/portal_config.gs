/**
 * Konfigurasi portal terpadu. Nilai di file ini bukan rahasia.
 */
const PORTAL_AUTH_DOMAIN = 'gbbnota.app';
const PORTAL_SESSION_HOURS = 4;
const PORTAL_SESSION_VERSION = 2;
const PORTAL_GEMINI_PRIMARY = 'gemini-3.5-flash-lite';
const PORTAL_GEMINI_FALLBACK = 'gemini-3.7-flash';
const PORTAL_GEMINI_MAX_ATTEMPTS = 2;
const PORTAL_MAX_UPLOAD_IMAGES = 5;
const PORTAL_MAX_RECEIPTS_PER_SUBMISSION = 20;
const PORTAL_MAX_ITEMS_PER_RECEIPT = 100;
const PORTAL_DEFAULT_PAGE_SIZE = 40;

const PORTAL_DEFAULT_CATEGORIES = [
  'TELUR',
  'GAS',
  'TEPUNG',
  'LISTRIK',
  'AIR GALON',
  'BAHAN BAKU',
  'BAHAN KEMAS',
  'OPERASIONAL TOKO',
  'LAIN-LAIN'
];

function portalNow_() {
  return new Date().getTime();
}

function portalPeriod_(dateValue) {
  const date = portalStrictDate_(dateValue);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyyMM');
}

function portalIsoDate_(dateValue) {
  const date = portalStrictDate_(dateValue);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function portalStrictDate_(dateValue) {
  if (dateValue instanceof Date) {
    if (isNaN(dateValue.getTime())) throw new Error('Tanggal tidak valid.');
    return dateValue;
  }
  const raw = String(dateValue == null ? '' : dateValue).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw new Error('Tanggal harus berformat YYYY-MM-DD.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error('Tanggal tidak valid.');
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error('Tanggal tidak valid.');
  }
  return date;
}

function portalValidatePeriod_(value) {
  const period = String(value || '').trim();
  const match = /^(\d{4})(\d{2})$/.exec(period);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
    throw new Error('Periode harus berformat YYYYMM dengan bulan 01–12.');
  }
  return period;
}

function portalValidateSpreadsheetUrl_(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)(?:[/?#].*)?$/i.exec(raw);
  if (!match) {
    throw new Error('URL harus berupa Google Spreadsheet HTTPS yang valid.');
  }
  return raw;
}

function portalFriendlyId_(prefix) {
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  return prefix + '-' + stamp + '-' + Utilities.getUuid().slice(0, 6).toUpperCase();
}

function portalUpper_(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

function portalSafeNumber_(value) {
  const cleaned = typeof value === 'string' ? value.replace(/\./g, '').replace(',', '.') : value;
  const number = Number(cleaned);
  return isFinite(number) ? number : 0;
}
