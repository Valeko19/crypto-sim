// Canonical OFFLINE full reset. Never import src/db/index or initDb here:
// even a dry-run must not apply migrations or invoke boot-time reset hooks.
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { applyFullReset, inspectReset, readResetReceipt, verifyFullReset } from '../src/admin/fullGameReset.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('reset:game --pgdata <existing absolute directory> --maintenance [--yes --operation-id <unique-id>]'); return; }
  const allowed = new Set(['--pgdata','--maintenance','--yes','--operation-id']);
  const values: Record<string,string> = {};
  for (let i=0;i<args.length;i++) {
    if (!allowed.has(args[i])) throw Error(`Unknown argument ${args[i]}`);
    if (args[i]==='--pgdata'||args[i]==='--operation-id') { const key=args[i]; const value=args[++i]; if (!value||value.startsWith('--')) throw Error(`Missing ${key}`); values[key]=value; }
  }
  const target=values['--pgdata'];
  if (!target || !path.isAbsolute(target) || !existsSync(path.join(target,'PG_VERSION'))) throw Error('Explicit --pgdata must name an existing absolute PGlite directory');
  if (!args.includes('--maintenance')) throw Error('Stop HTTP/engine/jobs first; --maintenance explicitly confirms exclusive offline ownership (not an OS process detector)');
  if (process.env.RUN_PLAYER_RESET) throw Error('Remove RUN_PLAYER_RESET before maintenance');
  const apply=args.includes('--yes'), operationId=values['--operation-id'];
  if (apply && (!operationId || !/^[A-Za-z0-9_-]{1,100}$/.test(operationId))) throw Error('--yes requires a unique --operation-id; keep it for uncertain-COMMIT recovery');
  const epoch=randomUUID();
  console.log(JSON.stringify({ target:realpathSync(target), mode:apply?'APPLY':'DRY RUN', operationId, proposedEpoch:epoch }));
  let db=new PGlite(target,{initialMemory:128*1024*1024});
  try {
    console.log(JSON.stringify(await inspectReset(db),null,2));
    if (!apply) return;
    let result;
    try { result=await applyFullReset(db,operationId!,epoch); }
    catch (error) {
      await db.close(); db=new PGlite(target,{initialMemory:128*1024*1024});
      const receipt=await readResetReceipt(db,operationId!);
      if (!receipt) throw error;
      await verifyFullReset(db,receipt);
      result={receipt,alreadyCommitted:true};
    }
    console.log('VERIFIED FULL RESET '+JSON.stringify(result));
  } finally { await db.close(); }
}
main().catch(error=>{console.error('FULL RESET FAILED. Keep maintenance mode; inspect the operation marker before any retry.',error);process.exitCode=1;});
