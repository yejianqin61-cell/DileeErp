export function buildVersion() {
  return process.env.APP_VERSION || "development";
}
