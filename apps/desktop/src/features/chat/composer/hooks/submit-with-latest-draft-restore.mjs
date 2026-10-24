const latestSubmissions = new Map();

/**
 * A unique token owns restoration until its request settles. Older pending
 * submissions cannot regain a draft slot after a newer submission releases it.
 *
 * @param {string} draftKey
 * @param {() => Promise<boolean>} submit
 * @param {() => void} restoreDraft
 * @returns {Promise<boolean>}
 */
export async function submitWithLatestDraftRestore(draftKey, submit, restoreDraft) {
  const token = Symbol();
  latestSubmissions.set(draftKey, token);
  try {
    const accepted = await submit();
    if (!accepted && latestSubmissions.get(draftKey) === token) restoreDraft();
    return accepted;
  } finally {
    if (latestSubmissions.get(draftKey) === token) latestSubmissions.delete(draftKey);
  }
}
