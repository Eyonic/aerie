import { applyPendingRestore, backupPaths } from './services/backup.js';
import { sqliteBackupCallbacks } from './services/sqlite-backup.js';

async function main() {
  const command = process.argv[2];
  if (command !== 'apply-pending') {
    console.error('Usage: backup-cli apply-pending');
    process.exitCode = 2;
    return;
  }
  const paths = backupPaths();
  const result = await applyPendingRestore({
    paths,
    ...sqliteBackupCallbacks(paths.dbPath),
  });
  if (result.applied) {
    console.log(`restore applied: ${result.artifact}; rollback bundle: ${result.safetyBackup}`);
  }
}

main().catch(error => {
  console.error('restore handoff failed; Aerie will remain offline:', error);
  process.exitCode = 1;
});
