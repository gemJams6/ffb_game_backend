// Shared team-password auth, used by both the draft session (picks) and the
// draft-availability endpoint, so a single TEAM_PASSWORDS_JSON env var and a
// single login (/api/team-login) works as one identity across every
// password-enforced feature on the site.

// Set via the TEAM_PASSWORDS_JSON env var, e.g. {"Dan":"eagles92","Grove":"..."}.
// Parsed lazily so a malformed/missing env var fails loudly at the point of
// use rather than crashing server startup.
function getTeamPasswords() {
  const raw = process.env.TEAM_PASSWORDS_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error("TEAM_PASSWORDS_JSON is not valid JSON:", err.message);
    return {};
  }
}

function checkTeamPassword(team, password) {
  const passwords = getTeamPasswords();
  return Boolean(team) && Boolean(password) && passwords[team] === password;
}

function fail(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function verifyTeamLogin({ team, password }) {
  if (!checkTeamPassword(team, password)) {
    throw fail("Incorrect team or password", 403);
  }
  return { ok: true };
}

module.exports = {
  checkTeamPassword,
  verifyTeamLogin,
  fail
};
