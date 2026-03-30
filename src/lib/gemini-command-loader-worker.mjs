import { pathToFileURL } from 'url';

const loaderPath = process.argv[2];
if (!loaderPath) { process.stdout.write('[]'); process.exit(0); }

try {
  const mod = await import(pathToFileURL(loaderPath).href);
  const config = {
    isAgentsEnabled: () => true,
    getExtensionsEnabled: () => true,
    getEnableExtensionReloading: () => false,
    getEnableHooksUI: () => true,
    getMcpEnabled: () => true,
    getFolderTrust: () => true,
    isPlanEnabled: () => true,
    isSkillsSupportEnabled: () => true,
    getSkillManager: () => ({ isAdminEnabled: () => true }),
    getCheckpointingEnabled: () => false,
  };
  const loader = new mod.BuiltinCommandLoader(config);
  const cmds = await loader.loadCommands();
  const result = cmds.filter(c => c && c.name).map(c => ({
    name: c.name || '',
    description: typeof c.description === 'string' ? c.description : '',
    altNames: Array.isArray(c.altNames) ? c.altNames.filter(Boolean) : [],
    subCommands: Array.isArray(c.subCommands) ? c.subCommands.map(s => s?.name || '').filter(Boolean) : [],
  }));
  process.stdout.write(JSON.stringify(result));
} catch (e) {
  process.stderr.write(String(e.message || e));
  process.stdout.write('[]');
}
