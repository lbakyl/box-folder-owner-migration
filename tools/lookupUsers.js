/**
 * Read-only: looks up Box user IDs by email, using the stored login
 * (tools/boxLogin.js). Prints a table; changes nothing.
 *
 * Usage: node tools/lookupUsers.js user1@example.com user2@example.com ...
 */
const { getBoxClientFromStoredLogin } = require('../src/lib/boxAuth');

async function main() {
  const emails = process.argv.slice(2);
  if (emails.length === 0) {
    console.error('Usage: node tools/lookupUsers.js user1@example.com user2@example.com ...');
    process.exit(1);
  }
  const client = getBoxClientFromStoredLogin();

  for (const email of emails) {
    // getUsers takes its params directly, unlike getFolderById/getUserById
    // which wrap them in { queryParams: {...} }. Easy to get wrong: if you
    // pass { queryParams: { filterTerm, limit } } here instead, Box silently
    // ignores the filter and returns its default unfiltered first page.
    const result = await client.users.getUsers({ filterTerm: email, limit: 5 });
    const hits = (result.entries || []).filter((u) => (u.login || '').toLowerCase() === email.toLowerCase());
    if (hits.length === 1) {
      console.log(`${email}\t${hits[0].id}\t${hits[0].name}\t${hits[0].status}`);
    } else if (hits.length === 0) {
      const all = result.entries || [];
      if (all.length === 0) {
        console.log(`${email}\tNOT FOUND (search returned nothing at all)`);
      } else {
        console.log(`${email}\tNOT FOUND (exact login), but the search returned:`);
        for (const u of all) console.log(`\t\t${u.id}\t${u.login}\t${u.name}\t${u.status}`);
      }
    } else {
      console.log(`${email}\tMULTIPLE MATCHES: ${hits.map((u) => `${u.id} (${u.name})`).join(', ')}`);
    }
  }
}

main().catch((err) => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
