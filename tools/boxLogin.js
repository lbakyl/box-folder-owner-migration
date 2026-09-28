/**
 * One-time sign-in as the current owner of the folder(s) you're migrating.
 *
 *   node tools/boxLogin.js            sign in and store the login
 *   node tools/boxLogin.js --logout   remove the stored login
 *
 * Needs the OAuth 2.0 app's Client ID and Client Secret (Developer Console,
 * Configuration tab) and the redirect URI shown below registered on that
 * app. The login lives in your user profile (~/.box-migration), never in
 * this project folder. Box access tokens last about an hour and refresh
 * themselves automatically; the refresh token lasts 60 days from its last
 * use, so run "--logout" once you're done rather than leaving it live.
 */
const http = require('http');
const readline = require('readline');
const crypto = require('crypto');
const { BoxClient } = require('box-node-sdk/sdk-gen');
const {
  DIR, REDIRECT_URI, buildAuth, saveAppConfig, readAppConfig, clearStoredLogin,
} = require('../src/lib/boxAuth');

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  if (process.argv.includes('--logout')) {
    clearStoredLogin();
    console.log('Stored login removed. If you\'re done migrating, also delete the app in the Developer Console.');
    return;
  }

  const existing = readAppConfig();
  const clientId = existing ? existing.clientId : await ask('Client ID: ');
  const clientSecret = existing ? existing.clientSecret : await ask('Client Secret (hidden): ', true);
  if (!clientId || !clientSecret) throw new Error('Client ID and Client Secret are both required.');
  saveAppConfig(clientId, clientSecret);

  const auth = buildAuth(clientId, clientSecret);
  const state = crypto.randomBytes(16).toString('hex');
  const url = auth.getAuthorizeUrl({ redirectUri: REDIRECT_URI, state });

  console.log('\n1. Open this address in a private browser window and sign in as the folders\' current owner:\n');
  console.log(url);
  console.log(`\n2. Approve the app. The browser will then show a short "done" message. Waiting on ${REDIRECT_URI} ...`);

  const code = await new Promise((resolve, reject) => {
    let settled = false;
    const servers = [];
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      for (const s of servers) { try { s.close(); } catch { /* already closed */ } }
      fn();
    };
    const handler = (req, res) => {
      const u = new URL(req.url, 'http://localhost:8765');
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
      res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/plain' });
      res.end(ok ? 'Signed in. You can close this window and go back to the terminal.' : 'Sign-in failed. Go back to the terminal.');
      finish(() => (ok
        ? resolve(u.searchParams.get('code'))
        : reject(new Error(u.searchParams.get('error_description') || 'State mismatch or no code returned.'))));
    };
    // "localhost" can resolve to the IPv6 loopback (::1) or the IPv4 one
    // (127.0.0.1) depending on the machine, so listen on both rather than
    // guess which one the browser will use.
    for (const host of ['127.0.0.1', '::1']) {
      const s = http.createServer(handler);
      s.on('error', () => { /* the other host may still work, e.g. IPv6 disabled */ });
      s.listen(8765, host);
      servers.push(s);
    }
    setTimeout(() => finish(() => reject(new Error('Timed out after 15 minutes. Run "node tools/boxLogin.js" again.'))), 15 * 60 * 1000);
  });

  await auth.getTokensAuthorizationCodeGrant(code);
  const me = await new BoxClient({ auth }).users.getUserMe();
  console.log(`\nSigned in as ${me.name} <${me.login}>. Login stored in ${DIR}.`);
}

main().catch((err) => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
