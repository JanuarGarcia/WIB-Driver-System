/** Standard API response: { code: 1|2, msg, details } */
function success(res, details = null, msg = 'OK') {
  return res.json({ code: 1, msg, details });
}

function error(res, msg = 'Error', code = 2) {
  return res.status(200).json({ code, msg, details: null });
}

module.exports = { success, error };
