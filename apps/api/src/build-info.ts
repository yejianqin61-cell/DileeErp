// git archive replaces this placeholder when the release is packed.
export const ARCHIVE_COMMIT = "$Format:%H$";

export function buildVersion() {
  return process.env.APP_VERSION || (ARCHIVE_COMMIT.includes("$Format:") ? "development" : ARCHIVE_COMMIT);
}
