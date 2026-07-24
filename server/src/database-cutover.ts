import {
  createDatabaseCutoverSnapshot,
  restoreDatabaseCutoverSnapshot,
  verifyDatabaseCutoverSnapshot,
} from './services/database-cutover.js';

function usage(): never {
  console.error([
    'Usage:',
    '  database-cutover snapshot SOURCE SNAPSHOT MANIFEST',
    '  database-cutover verify SNAPSHOT MANIFEST',
    '  database-cutover restore SNAPSHOT MANIFEST LIVE_DATABASE',
  ].join('\n'));
  process.exit(2);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'snapshot' && args.length === 3) {
    result = await createDatabaseCutoverSnapshot(args[0], args[1], args[2]);
  } else if (command === 'verify' && args.length === 2) {
    result = await verifyDatabaseCutoverSnapshot(args[0], args[1]);
  } else if (command === 'restore' && args.length === 3) {
    result = await restoreDatabaseCutoverSnapshot(args[0], args[1], args[2]);
  } else {
    usage();
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

main().catch(error => {
  console.error(`database cutover failed: ${String(error?.message || error)}`);
  process.exitCode = 1;
});
