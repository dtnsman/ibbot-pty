function checkSecret(setting, secret_key) {
  if (setting.closed) return { ok: false, msg: 'service closed' };
  if (setting.secret_key && secret_key !== setting.secret_key) {
    return { ok: false, msg: 'secret_key error!' };
  }
  return { ok: true };
}

module.exports = { checkSecret };