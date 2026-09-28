const { app } = require('@azure/functions');
const { getBoxClientFromStoredLogin, getBoxClientFromToken } = require('../lib/boxAuth');
const { migrateExistingFolder } = require('../lib/migrateFolder');

/**
 * Migrates an existing, already-populated folder (e.g. a shared "home
 * folder" currently owned by an admin or service account) to be owned by
 * the real person it belongs to. See migrateFolder.js for the full
 * reasoning and the exact sequence of steps.
 *
 * Defaults to a dry run: reports the current owner and every other
 * collaborator on the folder without changing anything. Pass
 * "confirm": true to actually perform the transfer and collaborator cleanup.
 *
 * Call with POST body:
 * {
 *   "folderId": "123456789",
 *   "userId": "<box user id>",
 *   "userName": "Jane Doe",
 *   "confirm": false,                  // optional, default false (dry run)
 *   "keepCollaboratorIds": ["12345"]   // optional, box user ids to leave untouched
 * }
 *
 * Authenticates as whoever signed in with `node tools/boxLogin.js` (see the
 * README) — this has to be the folder's current owner, since only the
 * owner can hand ownership to someone else. Pass "adminToken" in the body
 * instead to use a short-lived developer token for a quick one-off test.
 */
app.http('migrateHomeFolder', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return {
        status: 400,
        jsonBody: { error: 'Expected a JSON body with folderId, userId, and userName' },
      };
    }

    const { folderId, userId, userName, confirm, keepCollaboratorIds, adminToken } = body;
    if (!folderId || !userId || !userName) {
      return {
        status: 400,
        jsonBody: { error: 'folderId, userId, and userName are all required' },
      };
    }

    try {
      const client = adminToken ? getBoxClientFromToken(adminToken) : getBoxClientFromStoredLogin();
      const outcome = await migrateExistingFolder(
        client,
        folderId,
        userId,
        userName,
        { confirm: !!confirm, keepCollaboratorIds: keepCollaboratorIds || [], stagingParentId: body.stagingParentId },
        context
      );
      return { status: 200, jsonBody: outcome };
    } catch (err) {
      context.error('Home folder migration failed:', err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});
