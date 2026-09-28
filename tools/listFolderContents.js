/**
 * Read-only: lists everything directly inside one or more given parent
 * folders and writes it to a CSV, so you can compare it against your list
 * of Box users before migrating anything. Changes nothing in Box.
 *
 * Usage:
 *   node tools/listFolderContents.js 123456789 987654321
 *   node tools/listFolderContents.js "HR:123456789" "Sales:987654321"
 *
 * A "label:id" argument tags each row with that label in the "group"
 * column (handy if you're listing several sibling folders, e.g. one per
 * department or per A-Z range); a bare id just uses the id as its own label.
 *
 * Output goes to ./output/folder-contents-<date>.csv (git-ignored by
 * default — it will contain real names).
 */
const fs = require('fs');
const path = require('path');
const { BoxClient, BoxDeveloperTokenAuth } = require('box-node-sdk/sdk-gen');
const { hasStoredLogin, getBoxClientFromStoredLogin } = require('../src/lib/boxAuth');

// The list call only returns id/type/name; size, dates and owner come from a
// second call per folder (the list entries do not carry them).
const FIELDS = ['id', 'type', 'name'];
const DETAIL_FIELDS = ['id', 'name', 'size', 'created_at', 'modified_at', 'owned_by'];

const iso = (d) => (d && d.value && d.value.toISOString ? d.value.toISOString() : '');

async function getDetails(client, id, attempt = 1) {
  try {
    return await client.folders.getFolderById(id, { queryParams: { fields: DETAIL_FIELDS } });
  } catch (err) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return getDetails(client, id, attempt + 1);
    }
    throw err;
  }
}

// "Lastname, Firstname" -> "Firstname Lastname"; drops a trailing "(12345)".
// Returns the cleaned name plus any number found in parentheses (useful if
// your legacy folders were named after an old employee number).
function parseName(name) {
  let cleaned = String(name || '').trim();
  let embeddedNumber = '';
  const m = cleaned.match(/\((\d+)\)\s*$/);
  if (m) {
    embeddedNumber = m[1];
    cleaned = cleaned.slice(0, m.index).trim();
  }
  const comma = cleaned.match(/^([^,]+),\s*(.+)$/);
  if (comma) cleaned = `${comma[2].trim()} ${comma[1].trim()}`;
  return { parsedName: cleaned, embeddedNumber };
}

function csvCell(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function listAll(client, folderId) {
  const rows = [];
  let marker;
  do {
    const page = await client.folders.getFolderItems(folderId, {
      queryParams: { fields: FIELDS, limit: 1000, usemarker: true, marker },
    });
    rows.push(...(page.entries || []));
    marker = page.nextMarker || undefined;
  } while (marker);
  return rows;
}

function parseArgs(argv) {
  return argv.map((arg) => {
    const i = arg.indexOf(':');
    return i > 0 ? [arg.slice(0, i), arg.slice(i + 1)] : [arg, arg];
  });
}

async function main() {
  const groupFolders = parseArgs(process.argv.slice(2));
  if (groupFolders.length === 0) {
    console.error('Usage: node tools/listFolderContents.js [label:]folderId [[label:]folderId ...]');
    process.exit(1);
  }

  const token = process.env.BOX_ADMIN_TOKEN;
  let client;
  if (token) {
    client = new BoxClient({ auth: new BoxDeveloperTokenAuth({ token }) });
  } else if (hasStoredLogin()) {
    client = getBoxClientFromStoredLogin();
  } else {
    console.error('Set BOX_ADMIN_TOKEN, or sign in once with: node tools/boxLogin.js');
    process.exit(1);
  }

  const header = [
    'group', 'folder_id', 'type', 'name', 'parsed_name', 'embedded_number',
    'size_bytes', 'size_gb', 'created_at', 'modified_at', 'owner_id', 'owner_name', 'owner_login',
  ];
  const lines = [header.join(',')];
  const counts = {};
  let empty = 0;
  let failed = 0;

  for (const [group, folderId] of groupFolders) {
    const entries = await listAll(client, folderId);
    counts[group] = entries.length;

    // Fetch details a few folders at a time to stay well under rate limits.
    const details = new Array(entries.length).fill(null);
    for (let i = 0; i < entries.length; i += 6) {
      await Promise.all(
        entries.slice(i, i + 6).map(async (e, j) => {
          if (e.type !== 'folder') return;
          try {
            details[i + j] = await getDetails(client, e.id);
          } catch (err) {
            failed++;
            console.error(`  Could not read details of ${e.id} (${e.name}): ${err.message}`);
          }
        })
      );
    }

    entries.forEach((e, i) => {
      const d = details[i] || {};
      const size = d.size !== undefined ? Number(d.size) : '';
      if (size === 0) empty++;
      const owner = d.ownedBy || {};
      const { parsedName, embeddedNumber } = parseName(e.name);
      lines.push([
        group, e.id, e.type, e.name, parsedName, embeddedNumber,
        size, size === '' ? '' : (size / 1e9).toFixed(2),
        iso(d.createdAt), iso(d.modifiedAt), owner.id, owner.name, owner.login,
      ].map(csvCell).join(','));
    });
    console.log(`${group}: ${entries.length} items`);
  }

  const outDir = path.join(__dirname, '..', 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `folder-contents-${new Date().toISOString().slice(0, 10)}.csv`);
  fs.writeFileSync(outFile, lines.join('\r\n'), 'utf8');

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Total: ${total} items (${empty} with size 0, ${failed} without details). Written to ${outFile}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed:', err.message || err);
    process.exit(1);
  });
}

module.exports = { parseName, csvCell };
