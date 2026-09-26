// Public catalog only. Appointment availability and owner permissions always query the cloud.
let cached = null;
const MAX_AGE_MS = 5 * 60 * 1000;
function saveCatalog(services, now = Date.now()) {
  if (Array.isArray(services) && services.length) cached = { services, savedAt: now };
}
function getCatalog(now = Date.now()) {
  if (!cached || now < cached.savedAt || now - cached.savedAt >= MAX_AGE_MS) return null;
  return cached.services;
}
module.exports = { saveCatalog, getCatalog };
