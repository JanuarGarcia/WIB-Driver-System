const path = require('path');

/**
 * Root uploads directory (profiles, merchants, task proofs, …).
 * Set UPLOADS_DIR on the server when files live outside the repo (uploads/ is gitignored).
 * @returns {string}
 */
function getUploadsRoot() {
  return process.env.UPLOADS_DIR
    ? path.resolve(process.env.UPLOADS_DIR)
    : path.join(__dirname, '..', 'uploads');
}

module.exports = { getUploadsRoot };
