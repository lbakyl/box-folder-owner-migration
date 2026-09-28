/**
 * Migrates an existing, already-populated folder (e.g. a shared "home
 * folder" currently owned by an admin or service account) to be owned by
 * the real person it belongs to.
 *
 * This never creates a folder or copies any data. Box ownership transfer
 * is a metadata-only operation regardless of folder size, so a folder in
 * the hundreds of GB transfers exactly as fast as an empty one. The folder
 * stays wherever it currently lives in the tree; only its owner (and
 * collaborator list) changes.
 *
 * Defaults to a dry run (report only, no changes) so that every existing
 * collaborator beyond the target user gets surfaced and reviewed before
 * anything is removed. Some of that access may be legitimate (e.g. a
 * manager who genuinely needs visibility into a direct report's files) and
 * shouldn't be silently stripped. Default behavior once confirmed IS to
 * remove everyone not explicitly kept: the point of this tool is that
 * nobody but the owner should have standing access to their folder unless
 * there's a deliberate, reviewed reason.
 *
 * @param {import('box-node-sdk/sdk-gen').BoxClient} client
 * @param {string} folderId - Box folder ID of the existing folder to migrate
 * @param {string} userId - Box user ID of the person this folder belongs to
 * @param {string} userName - display name, used for the friendly folder name
 * @param {{confirm?: boolean, keepCollaboratorIds?: string[], stagingParentId?: string}} options
 * @param {{log: Function, warn: Function}} logger - context.log/context.warn from the caller
 */
// Independent safety check, straight from Box for this one collaboration:
// it must be attached to the folder we were asked to migrate, not to a parent.
async function assertOnFolder(client, collaborationId, folderId) {
  const c = await client.userCollaborations.getCollaborationById(collaborationId);
  if (!c.item || String(c.item.id) !== String(folderId)) {
    throw new Error(
      `Refusing to change collaboration ${collaborationId}: it belongs to item ${c.item ? c.item.id : 'unknown'}, not folder ${folderId}.`
    );
  }
}

async function migrateExistingFolder(client, folderId, userId, userName, options, logger) {
  const confirm = !!(options && options.confirm);
  const keepIds = (options && options.keepCollaboratorIds) || [];
  const keepSet = new Set([String(userId), ...keepIds.map(String)]);

  const folder = await client.folders.getFolderById(folderId);
  const before = await client.listCollaborations.getFolderCollaborations(folderId);
  // A folder's collaboration list also includes access inherited from parent
  // folders. Such an entry's "item" is the ANCESTOR it was created on.
  // Upgrading or deleting one changes the whole parent tree: every other
  // folder under it, not just this one. So only collaborations created
  // directly on this exact folder are ever touched. (This is not a
  // hypothetical: mixing these up is the easiest way to accidentally
  // transfer ownership of an entire shared tree instead of one folder.)
  const isDirect = (c) => !c.item || String(c.item.id) === String(folder.id);
  const allCollaborations = before.entries || [];
  const collaborations = allCollaborations.filter(isDirect);
  const inheritedCollaborators = allCollaborations.filter((c) => !isDirect(c)).map((c) => ({
    id: c.accessibleBy && c.accessibleBy.id,
    name: c.accessibleBy && c.accessibleBy.name,
    login: c.accessibleBy && c.accessibleBy.login,
    role: c.role,
    inheritedFromFolder: c.item && { id: c.item.id, name: c.item.name },
  }));

  const targetCollab = collaborations.find((c) => c.accessibleBy && String(c.accessibleBy.id) === String(userId));
  // Box never lists the owner as a collaboration, only on the folder itself.
  const owner = folder.ownedBy;

  const describe = (c) => ({
    collaborationId: c.id,
    id: c.accessibleBy && c.accessibleBy.id,
    name: c.accessibleBy && c.accessibleBy.name,
    login: c.accessibleBy && c.accessibleBy.login,
    role: c.role,
  });

  const wouldRemove = collaborations.filter((c) => !keepSet.has(String(c.accessibleBy && c.accessibleBy.id))).map(describe);
  const wouldKeep = collaborations
    .filter((c) => keepSet.has(String(c.accessibleBy && c.accessibleBy.id)) && String(c.accessibleBy && c.accessibleBy.id) !== String(userId))
    .map(describe);

  // People on the keep list whose access is only inherited from a parent
  // folder. Once this folder leaves that tree, inherited access disappears,
  // so give them a direct entry on this folder first, to actually keep
  // their access rather than silently lose it.
  const directIds = new Set(collaborations.map((c) => String(c.accessibleBy && c.accessibleBy.id)));
  const wouldAddDirect = keepIds
    .map(String)
    .filter((id) => id !== String(userId) && !directIds.has(id))
    .map((id) => allCollaborations.find((c) => !isDirect(c) && String(c.accessibleBy && c.accessibleBy.id) === id))
    .filter(Boolean)
    .map((c) => ({
      id: c.accessibleBy.id,
      name: c.accessibleBy.name,
      login: c.accessibleBy.login,
      role: c.role === 'owner' ? 'co-owner' : c.role,
    }));

  // Two separate reasons a folder needs to leave its parent tree:
  //  1. Box refuses a direct entry for someone who already inherits access
  //     from a parent ("user_already_collaborator"), and only a direct entry
  //     can be upgraded to owner or granted to someone on the keep list.
  //  2. Even when neither of those blocks anything, leaving the folder
  //     nested means whoever collaborates on the PARENT folder keeps
  //     standing access to it forever, regardless of who now owns the
  //     child. Ownership transfer alone does not sever inherited access.
  //     If the whole point of migrating is to end standing access from a
  //     shared structure, any inherited access at all means the folder
  //     must move, not just cases that would otherwise fail outright.
  const targetHasInherited = allCollaborations.some(
    (c) => !isDirect(c) && String(c.accessibleBy && c.accessibleBy.id) === String(userId)
  );
  const stagingParentId = (options && options.stagingParentId) || '0';
  const needsMove =
    !(owner && String(owner.id) === String(userId)) &&
    ((!targetCollab && targetHasInherited) || wouldAddDirect.length > 0 || allCollaborations.some((c) => !isDirect(c)));

  // The new owner's storage limit must cover the folder they're about to own
  // (Box rejects the transfer with storage_limit_exceeded otherwise, possibly
  // after other steps have already run). If the caller isn't allowed to read
  // user details, report that and carry on rather than block the migration.
  let storageCheck;
  try {
    const target = await client.users.getUserById(userId, {
      queryParams: { fields: ['name', 'space_amount', 'space_used'] },
    });
    const folderBytes = Number(folder.size || 0);
    const limitBytes = Number(target.spaceAmount);
    const usedBytes = Number(target.spaceUsed || 0);
    const unlimited = !(limitBytes > 0) || limitBytes >= 1e15;
    storageCheck = {
      limitBytes: unlimited ? 'unlimited' : limitBytes,
      usedBytes,
      folderBytes,
      sufficient: unlimited || usedBytes + folderBytes <= limitBytes,
    };
  } catch (e) {
    storageCheck = { error: `Could not read the user's storage limit: ${e.message}` };
  }

  const report = {
    folderId: folder.id,
    storageCheck,
    wouldMoveOutOfTree: needsMove ? { toParentFolderId: stagingParentId } : false,
    folderName: folder.name,
    currentOwner: owner ? { id: owner.id, name: owner.name, login: owner.login } : null,
    targetUser: {
      id: userId,
      name: userName,
      isCurrentCollaborator: !!targetCollab || !!(owner && String(owner.id) === String(userId)),
      currentRole: owner && String(owner.id) === String(userId) ? 'owner' : targetCollab ? targetCollab.role : null,
    },
    wouldRemove,
    wouldKeep,
    wouldAddDirect,
    inheritedCollaborators, // never touched; access comes from a parent folder
  };

  if (!confirm) {
    logger.log(
      `[DRY RUN] Folder ${folder.id} ("${folder.name}"): would transfer ownership to ${userId} (${userName}). ` +
        `${wouldRemove.length} collaborator(s) would be removed, ${wouldKeep.length} kept. Pass confirm: true to execute.`
    );
    return { dryRun: true, ...report };
  }

  if (storageCheck.sufficient === false && !(owner && String(owner.id) === String(userId))) {
    throw new Error(
      `${userName}'s storage limit is too small for this folder (limit ${storageCheck.limitBytes} bytes, used ${storageCheck.usedBytes}, folder ${storageCheck.folderBytes}). Raise it in the Admin Console first. Nothing was changed.`
    );
  }

  // Only the current owner can hand over ownership, and a co-owner cannot
  // do this on its own (confirmed against Box's API: 403). If someone
  // already made the target user the owner by hand, skip straight to
  // the cleanup below.
  const alreadyOwner = owner && String(owner.id) === String(userId);
  const me = await client.users.getUserMe();
  const removed = [];
  const kept = [];
  const originalParentId = folder.parent && folder.parent.id;
  // Declared here, not inside the try block below, so it's still in scope
  // for the return statement after the try/catch closes.
  let friendlyName = `${userName} - Home`;

  try {

  if (alreadyOwner) {
    logger.log(`User ${userId} already owns folder ${folder.id}, skipping the ownership transfer.`);
  } else {
    if (needsMove) {
      if (!owner || String(owner.id) !== String(me.id)) {
        throw new Error('This folder must be moved out of its parent tree first, which only its current owner can do. Sign in as that owner (see README) before running this.');
      }
      await client.folders.updateFolderById(folder.id, {
        requestBody: { parent: { id: stagingParentId } },
      });
      logger.log(
        `Moved folder ${folder.id} out of its parent tree (was in folder ${folder.parent && folder.parent.id} "${folder.parent && folder.parent.name}") ` +
          `to folder ${stagingParentId} because its access was inherited only. To roll back, move it back to folder ${folder.parent && folder.parent.id}.`
      );
    }

    for (const p of wouldAddDirect) {
      await client.userCollaborations.createCollaboration({
        item: { type: 'folder', id: folder.id },
        accessibleBy: { type: 'user', id: p.id },
        role: p.role,
      });
      logger.log(`Added direct ${p.role} access for ${p.login || p.id} on folder ${folder.id} so it survives the move`);
    }

    // If the caller IS the current owner (signed in as them via the stored
    // login or a developer token), clear everyone else out first: after
    // handing over ownership the caller is only an editor and can no
    // longer remove other collaborators.
    if (owner && String(owner.id) === String(me.id)) {
      for (const c of collaborations) {
        const id = c.accessibleBy && c.accessibleBy.id;
        if (keepSet.has(String(id))) continue;
        await assertOnFolder(client, c.id, folder.id);
        await client.userCollaborations.deleteCollaborationById(c.id);
        logger.log(`Removed collaboration for ${(c.accessibleBy && c.accessibleBy.login) || id} (was ${c.role}) on folder ${folder.id}`);
        removed.push(describe(c));
      }
    }

    // 1. Ensure the target user is a collaborator (usually already true for
    //    an existing legacy folder, but handle the gap just in case).
    let collaboration = targetCollab;
    if (!collaboration) {
      collaboration = await client.userCollaborations.createCollaboration({
        item: { type: 'folder', id: folder.id },
        accessibleBy: { type: 'user', id: userId },
        role: 'editor',
      });
      logger.log(`Added user ${userId} as editor on folder ${folder.id} (was not previously a collaborator)`);
    }

    // 2. Upgrade to owner. Transfers ownership; the prior owner is
    //    automatically demoted to editor on this folder as a side effect.
    //    Fails with 403 unless the caller is the current owner.
    await assertOnFolder(client, collaboration.id, folder.id);
    await client.userCollaborations.updateCollaborationById(collaboration.id, {
      requestBody: { role: 'owner' },
    });
    logger.log(`Transferred ownership of folder ${folder.id} to user ${userId}`);
  }

  // Rename to a friendly display name while the caller still has access
  // (the cleanup below removes it). Best-effort, non-fatal: ownership
  // matters far more than the cosmetic name.
  try {
    await client.folders.updateFolderById(folder.id, {
      requestBody: { name: friendlyName },
    });
    logger.log(`Renamed folder ${folder.id} to "${friendlyName}"`);
  } catch (renameErr) {
    logger.warn(`Could not rename folder ${folder.id}, continuing anyway. Error: ${renameErr.message}`);
  }

  // 3. Re-fetch collaborations post-transfer (roles shifted) and remove
  //    everyone not explicitly kept.
  const after = await client.listCollaborations.getFolderCollaborations(folder.id);
  // The caller removes itself last: once it's gone it can no
  // longer delete anyone else's collaboration.
  const ordered = (after.entries || []).filter(isDirect).sort(
    (a, b) => (String(a.accessibleBy && a.accessibleBy.id) === String(me.id)) - (String(b.accessibleBy && b.accessibleBy.id) === String(me.id))
  );
  for (const c of ordered) {
    const id = c.accessibleBy && c.accessibleBy.id;
    if (String(id) === String(userId)) {
      // The new owner never needs a separate collaboration. A leftover editor
      // entry (from the one created for the upgrade) is redundant; try to
      // remove it, but don't fail the migration if the caller can't.
      if (c.role !== 'owner') {
        try {
          await assertOnFolder(client, c.id, folder.id);
          await client.userCollaborations.deleteCollaborationById(c.id);
          logger.log(`Removed redundant ${c.role} entry for the new owner ${(c.accessibleBy && c.accessibleBy.login) || id}`);
        } catch (redundantErr) {
          logger.warn(`Could not remove the new owner's redundant ${c.role} entry (harmless): ${redundantErr.message}`);
        }
      }
      continue;
    }
    if (keepSet.has(String(id))) {
      kept.push(describe(c));
      continue;
    }
    await assertOnFolder(client, c.id, folder.id);
    await client.userCollaborations.deleteCollaborationById(c.id);
    logger.log(`Removed collaboration for ${(c.accessibleBy && c.accessibleBy.login) || id} (was ${c.role}) on folder ${folder.id}`);
    removed.push(describe(c));
  }

  } catch (migrationErr) {
    // A failure partway through (commonly Box's 409 operation_blocked_temporary
    // on a large or recently-moved folder) does not mean nothing happened.
    // an earlier step in this same call, e.g. the move out of the parent
    // tree, can have already gone through. Re-check and report the real
    // state instead of leaving the caller to run a separate dry run to
    // find out.
    let statusNote;
    try {
      const nowFolder = await client.folders.getFolderById(folderId);
      const stillNested = nowFolder.parent && String(nowFolder.parent.id) === String(originalParentId);
      statusNote =
        `Current state: owner is ${nowFolder.ownedBy && nowFolder.ownedBy.login}; ` +
        `folder is ${stillNested ? `still under "${nowFolder.parent.name}"` : 'already moved out of its original parent'}. ` +
        'Run this same request again without confirm to see the full picture before retrying with confirm.';
    } catch (checkErr) {
      statusNote = `Could not re-check the folder's state after the error (${checkErr.message}). Run a dry run before retrying.`;
    }
    migrationErr.message = `${migrationErr.message}. ${statusNote}`;
    throw migrationErr;
  }

  return { dryRun: false, folderId: folder.id, folderName: friendlyName, ownedBy: userId, removed, kept };
}

module.exports = { migrateExistingFolder };
