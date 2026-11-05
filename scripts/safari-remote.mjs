// Build on Windows/macOS, send only generated resources + the wrapper over SSH,
// and compile/sign on the Mac. --install installs but never launches/controls apps.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
let local = {};
try { local = JSON.parse(await readFile(new URL('../platforms/safari/build.local.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const host = process.env.SYF_SAFARI_HOST || local.host;
const remoteRoot = process.env.SYF_SAFARI_ROOT || local.remoteRoot;
const team = process.env.SYF_APPLE_TEAM || local.team;
const device = process.env.SYF_IOS_DEVICE || local.device;
const hostKeyAlias = process.env.SYF_SAFARI_HOST_KEY_ALIAS || local.hostKeyAlias;
const unsigned = process.argv.includes('--unsigned');
const install = process.argv.includes('--install');
const loginSession = process.env.SYF_SAFARI_LOGIN_SESSION !== undefined
  ? process.env.SYF_SAFARI_LOGIN_SESSION === '1' : local.loginSession === true;
if (!host || !/^[\w.@-]+$/.test(host) || host.startsWith('-')) throw Error('Set SYF_SAFARI_HOST or build.local.json host to an SSH host.');
if (!remoteRoot || !/^\/Users\/[\w.-]+\/[\w./-]+$/.test(remoteRoot) || remoteRoot.split('/').includes('..')) throw Error('Set SYF_SAFARI_ROOT or remoteRoot to a dedicated absolute folder under /Users.');
if (!unsigned && !/^[A-Z0-9]{10}$/.test(team || '')) throw Error('Set SYF_APPLE_TEAM or build.local.json team to your developer team ID.');
if (install && (unsigned || !/^[A-Za-z0-9-]+$/.test(device || ''))) throw Error('--install requires a signed build and SYF_IOS_DEVICE or build.local.json device.');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} failed (exit ${result.status}).`);
}
const hostOptions = hostKeyAlias ? ['-o', `HostKeyAlias=${hostKeyAlias}`] : [];
const ssh = (command) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=yes', ...hostOptions, host, command]);
const upload = (from, to) => run('scp', ['-q', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', ...hostOptions, '-r', from, `${host}:${to}`]);
run(process.execPath, ['scripts/build.mjs', '--safari']);
// Fresh input directory prevents stale/sourcemap assets being packaged after a
// release build. Deliberately never delete another checkout or remote directory.
const staging = `${remoteRoot}/incoming-${Date.now()}`;
ssh(`mkdir -p ${quote(staging + '/platforms/safari')} ${quote(remoteRoot + '/build')}`);
upload('dist-safari', staging + '/');
upload('platforms/safari/SethsYouTubeFixer', staging + '/platforms/safari/');
upload('scripts/validate-safari.m', staging + '/');
ssh(`xcrun clang -fobjc-arc -framework Foundation -framework WebKit ${quote(staging + '/validate-safari.m')} -o ${quote(staging + '/validate-safari')} && ${quote(staging + '/validate-safari')} ${quote(staging + '/dist-safari')}`);
const project = `${staging}/platforms/safari/SethsYouTubeFixer/SethsYouTubeFixer.xcodeproj`;
const log = `${remoteRoot}/build.log`;
const args = ['-project', project, '-scheme', 'SethsYouTubeFixer', '-configuration', 'Debug',
  '-destination', 'generic/platform=iOS', '-derivedDataPath', `${remoteRoot}/build`,
  ...(unsigned ? ['CODE_SIGNING_ALLOWED=NO'] : [`DEVELOPMENT_TEAM=${team}`, '-allowProvisioningUpdates', '-allowProvisioningDeviceRegistration']), 'build'];
const buildCommand = `xcodebuild ${args.map(quote).join(' ')} > ${quote(log)} 2>&1`;
if (loginSession && !unsigned) {
  // A GUI login and SSH can have different keychain security contexts. Run only
  // the compiler/signing job in the user's existing login session; never launch
  // Xcode, Safari, or the containing app. Unload the one-shot job after completion.
  const label = `com.rtsoft.syf-build-${Date.now()}`;
  const plistPath = `${staging}/build-job.plist`;
  const statusPath = `${staging}/build-result`;
  const job = { Label: label, RunAtLoad: true, ProgramArguments: ['/bin/bash', '-c',
    `${buildCommand}; result=$?; printf '%s\\n' "$result" > ${quote(statusPath)}; exit "$result"`] };
  const python = 'import json, plistlib, sys; plistlib.dump(json.loads(sys.argv[1]), open(sys.argv[2], "wb"))';
  ssh(`python3 -c ${quote(python)} ${quote(JSON.stringify(job))} ${quote(plistPath)}`);
  ssh(`domain="gui/$(id -u)"; launchctl bootstrap "$domain" ${quote(plistPath)} || exit $?;
trap 'launchctl bootout "$domain/${label}" >/dev/null 2>&1 || true' EXIT
attempt=0
while [ ! -f ${quote(statusPath)} ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 450 ]; then tail -n 35 ${quote(log)}; echo 'Login-session build timed out.' >&2; exit 1; fi
  sleep 2
done
result=$(cat ${quote(statusPath)}); tail -n 35 ${quote(log)}; exit "$result"`);
} else {
  ssh(`${buildCommand}; result=$?; tail -n 35 ${quote(log)}; exit $result`);
}
const app = `${remoteRoot}/build/Build/Products/Debug-iphoneos/SethsYouTubeFixer.app`;
console.log(`Built ${unsigned ? 'unsigned ' : ''}app: ${host}:${app}`);
if (!unsigned) ssh(`codesign --verify --deep --strict ${quote(app)}`);
if (install) {
  ssh(`xcrun devicectl device install app --device ${quote(device)} ${quote(app)}`);
  const installed = `${staging}/installed-app.json`;
  ssh(`xcrun devicectl device info apps --device ${quote(device)} --bundle-id com.rtsoft.sethsyoutubefixer --json-output ${quote(installed)}`);
  const verify = `import json, plistlib, sys
result = json.load(open(sys.argv[1]))
built = plistlib.load(open(sys.argv[2], 'rb'))
apps = result.get('result', {}).get('apps', [])
assert result['info']['outcome'] == 'success' and len(apps) == 1, 'App not found on device'
assert apps[0]['version'] == built['CFBundleShortVersionString'] and apps[0]['bundleVersion'] == built['CFBundleVersion'], 'Installed version does not match build'
print('Verified installed version ' + apps[0]['version'] + ' (' + apps[0]['bundleVersion'] + ')')`;
  ssh(`python3 -c ${quote(verify)} ${quote(installed)} ${quote(app + '/Info.plist')}`);
}
