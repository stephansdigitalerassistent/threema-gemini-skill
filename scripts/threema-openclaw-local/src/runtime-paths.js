const modulePath = '../../../node_modules/threema-openclaw/src/runtime-paths.js';
const mod = await import(modulePath);
export const resolveThreemaDataDir = mod.resolveThreemaDataDir;
export const resolveThreemaIdentityPath = mod.resolveThreemaIdentityPath;
