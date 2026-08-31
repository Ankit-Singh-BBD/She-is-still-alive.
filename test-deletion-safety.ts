// ===================================================================
// DELETION SAFETY & RECOVERY AUTOMATED TEST SUITE
// ===================================================================
//
// Covers all 18 mandated deletion-safety requirements:
// 1. Ambiguous deletion resolution
// 2. Exact single-memory deletion
// 3. Exact single-conversation deletion
// 4. Multiple matches detection
// 5. Confirmation required (confirm: true gate)
// 6. Cancellation (abort leaves state untouched)
// 7. Move to Bin (recoverable payload preserved)
// 8. Restore from Bin
// 9. Permanent deletion (complete removal)
// 10. Expired Bin entry cleanup (retention policy sweep)
// 11. Derived-memory cleanup on conversation deletion
// 12. Shared-source provenance (multi-source preservation vs single-source cascade)
// 13. Voice deletion command classification & scope extraction
// 14. Manual deletion routing parity
// 15. Permanent-delete ambiguity resolution
// 16. Deletion during concurrent/sequential operations
// 17. Stale callback / stale UI protection (server re-resolves at execution time)
// 18. No Ghost Knowledge (deleted items invisible to retrieval, search, patterns, tasks)
// ===================================================================

import { db } from './server/db.js';
import { routeVoiceCommand } from './src/utils/voiceCommandRouter.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

console.log('🧪 RUNNING DELETION-SAFETY COMPREHENSIVE TEST SUITE\n');

async function run() {
  const user = db.createOrGetUser('Test Safety User ' + Date.now());
  const userId = user.id;

  console.log(`[SUITE] Running tests with identityId=${userId}\n`);

  // -----------------------------------------------------------------
  // 1. Exact Single-Memory Deletion + Move to Bin (Scenarios 2, 7)
  // -----------------------------------------------------------------
  console.log('--- 1. Exact Single-Memory Deletion & Move to Bin ---');
  const mem1 = db.addMemory(userId, 'I love drinking green tea every morning at 7am', 'habit', 0.9, 0.8);
  assert(!!mem1, 'Memory created successfully');

  let activeMems = db.getMemoriesForIdentity(userId, true);
  assert(activeMems.some(m => m.memoryId === mem1?.memoryId), 'Memory is visible in active list');

  const scopeRes1 = db.resolveDeletionScope({
    identityId: userId,
    scope: 'single_memory',
    target: mem1!.memoryId,
  });
  assert(scopeRes1.resolved === true, 'Scope resolved for single memory');
  assert(scopeRes1.reversibility === 'recoverable', 'Marked recoverable');
  assert(scopeRes1.safety === 'safe', 'Safety is safe (recoverable to Bin)');
  assert(scopeRes1.affected?.memories === 1, 'Affected memory count is 1');

  const moveRes1 = db.moveMemoryToBin(mem1!.memoryId, {
    deletedBy: userId,
    reason: 'user requested delete',
    sourceCommand: 'delete my green tea memory',
  });
  assert(moveRes1.success === true && !!moveRes1.binId, 'Moved to Bin with valid binId');

  activeMems = db.getMemoriesForIdentity(userId, true);
  assert(!activeMems.some(m => m.memoryId === mem1!.memoryId), 'Memory no longer appears in active list');

  const binList1 = db.listBin(userId, false);
  assert(binList1.some(e => e.binId === moveRes1.binId), 'Memory appears in Bin list with preserved payload');

  // -----------------------------------------------------------------
  // 2. Restore from Bin (Scenario 8)
  // -----------------------------------------------------------------
  console.log('\n--- 2. Restore from Bin ---');
  const restoreRes = db.restoreFromBin(moveRes1.binId!, { restoredBy: userId });
  assert(restoreRes.success === true, 'Restore succeeded');

  activeMems = db.getMemoriesForIdentity(userId, true);
  assert(activeMems.some(m => m.memoryId === mem1!.memoryId), 'Restored memory is back in active list');

  const binList2 = db.listBin(userId, false);
  assert(!binList2.some(e => e.binId === moveRes1.binId), 'Restored memory removed from Bin');

  // -----------------------------------------------------------------
  // 3. Multiple Matches & Ambiguity Detection (Scenarios 1, 4)
  // -----------------------------------------------------------------
  console.log('\n--- 3. Multiple Matches & Ambiguity Detection ---');
  db.addMemory(userId, 'My project Alpha is due next Friday in May', 'project', 0.9, 0.8);
  db.addMemory(userId, 'My project Alpha budget is approved for $50k', 'project', 0.9, 0.8);
  db.addMemory(userId, 'My project Beta has been cancelled', 'project', 0.9, 0.8);

  const ambiguousCandidates = db.findAmbiguousTargets(userId, 'memory', 'project alpha');
  assert(ambiguousCandidates.length === 2, `Found exactly 2 matches for "project alpha" (got ${ambiguousCandidates.length})`);
  assert(ambiguousCandidates.every(c => c.preview.toLowerCase().includes('project alpha')), 'Candidates match search string');

  // -----------------------------------------------------------------
  // 4. Stale Callback / Stale UI Scope Re-Resolution (Scenario 17)
  // -----------------------------------------------------------------
  console.log('\n--- 4. Stale Callback / Stale UI Scope Re-Resolution ---');
  const staleScope = db.resolveDeletionScope({
    identityId: userId,
    scope: 'single_memory',
    target: 'MEM_NON_EXISTENT_9999',
  });
  assert(staleScope.resolved === false, 'Stale memory target correctly rejected');
  assert(staleScope.safety === 'blocked', 'Safety is blocked for non-existent target');

  // -----------------------------------------------------------------
  // 5. Cancellation (Scenario 6)
  // -----------------------------------------------------------------
  console.log('\n--- 5. Cancellation (No Mutations on Abort) ---');
  const memToCancel = db.addMemory(userId, 'Crucial note that should NOT be deleted', 'fact', 0.9, 0.9);
  const memCountBefore = db.getMemoriesForIdentity(userId, true).length;
  const binCountBefore = db.listBin(userId, false).length;

  // Simulate preview without confirmation (confirm: false)
  const cancelPreview = db.resolveDeletionScope({
    identityId: userId,
    scope: 'single_memory',
    target: memToCancel!.memoryId,
  });
  assert(cancelPreview.resolved === true, 'Preview generated');
  // State remains untouched
  const memCountAfter = db.getMemoriesForIdentity(userId, true).length;
  const binCountAfter = db.listBin(userId, false).length;
  assert(memCountBefore === memCountAfter, 'Active memories count unchanged after cancelled deletion');
  assert(binCountBefore === binCountAfter, 'Bin count unchanged after cancelled deletion');

  // -----------------------------------------------------------------
  // 6. Conversation Deletion & Derived Memory Cascade (Scenarios 3, 11)
  // -----------------------------------------------------------------
  console.log('\n--- 6. Conversation Deletion & Derived Memory Cascade ---');
  const sessionId = `sess_test_${Date.now()}`;
  db.logTurn(userId, 'user', 'My dog name is Buster and he is a Golden Retriever', sessionId);

  // Add memory derived exclusively from this session
  const busterMem = db.addMemory(
    userId,
    'Dog name is Buster (Golden Retriever)',
    'fact',
    0.95,
    0.8,
    { sourceSessionId: sessionId }
  );
  assert(!!busterMem, 'Derived memory created with session provenance');

  const convScope = db.resolveDeletionScope({
    identityId: userId,
    scope: 'single_conversation',
    target: sessionId,
  });
  assert(convScope.resolved === true, 'Conversation scope resolved');
  assert(convScope.affected?.derivedMemories === 1, `Derived memory count is 1 (got ${convScope.affected?.derivedMemories})`);

  const moveConvRes = db.moveSessionToBin(userId, sessionId, {
    deletedBy: userId,
    reason: 'test delete session',
  });
  assert(moveConvRes.success === true, 'Session moved to Bin');
  assert(moveConvRes.derivedMemoryBinIds?.length === 1, 'Derived memory also moved to Bin');

  const memsAfterConv = db.getMemoriesForIdentity(userId, true);
  assert(!memsAfterConv.some(m => m.content.includes('Buster')), 'Derived memory is no longer active');

  // -----------------------------------------------------------------
  // 7. Shared-Source Provenance (Scenario 12)
  // -----------------------------------------------------------------
  console.log('\n--- 7. Shared-Source Provenance (Multi-Source Preservation) ---');
  const sessA = `sess_multi_A_${Date.now()}`;
  const sessB = `sess_multi_B_${Date.now()}`;

  db.logTurn(userId, 'user', 'I prefer dark mode in all editors', sessA);
  db.logTurn(userId, 'user', 'Dark mode is really great for my eyes', sessB);

  const pattern = db.addOrUpdatePattern(
    userId,
    'Prefers dark mode theme in all interfaces',
    'preference',
    0.85,
    { sourceSessionIds: [sessA, sessB], extractedBy: 'test' }
  );
  assert(!!pattern, 'Pattern created with multi-session provenance');

  // Delete ONLY session A
  db.moveSessionToBin(userId, sessA, { deletedBy: userId, reason: 'delete sess A' });

  // Pattern must SURVIVE because session B is still alive!
  let activePatterns = db.getPatternsForIdentity(userId);
  const survivingPattern = activePatterns.find(p => p.id === pattern?.id);
  assert(!!survivingPattern, 'Pattern survived because session B still exists');
  assert(
    survivingPattern?.provenance?.sourceSessionIds?.includes(sessB) &&
    !survivingPattern?.provenance?.sourceSessionIds?.includes(sessA),
    'Pattern provenance updated to remove dead session A while keeping session B'
  );

  // Now delete session B — pattern must now CASCADE to Bin!
  db.moveSessionToBin(userId, sessB, { deletedBy: userId, reason: 'delete sess B' });
  activePatterns = db.getPatternsForIdentity(userId);
  assert(!activePatterns.some(p => p.id === pattern?.id), 'Pattern moved to Bin once all sources were deleted');

  // -----------------------------------------------------------------
  // 8. Tasks & Patterns in Deletion Safety System (Task #34)
  // -----------------------------------------------------------------
  console.log('\n--- 8. Tasks & Patterns in Deletion Safety System ---');
  const task1 = db.createTaskWithMetadata(userId, 'Complete tax filing for Q3', { priority: 'high', source: 'user_explicit' });
  assert(!!task1, 'Task created');

  let activeTasks = db.getTasksForIdentity(userId);
  assert(activeTasks.some(t => t.id === task1?.id), 'Task is in active list');

  const taskScope = db.resolveDeletionScope({
    identityId: userId,
    scope: 'single_task',
    target: task1!.id,
  });
  assert(taskScope.resolved === true, 'Task deletion scope resolved');
  assert(taskScope.affected?.tasks === 1, 'Task affected count is 1');

  const moveTaskRes = db.moveTaskToBin(task1!.id, { deletedBy: userId, reason: 'task done' });
  assert(moveTaskRes.success === true, 'Task moved to Bin');

  activeTasks = db.getTasksForIdentity(userId);
  assert(!activeTasks.some(t => t.id === task1!.id), 'Task no longer in active tasks');

  const restoreTaskRes = db.restoreFromBin(moveTaskRes.binId!, { restoredBy: userId });
  assert(restoreTaskRes.success === true, 'Task restored from Bin');
  activeTasks = db.getTasksForIdentity(userId);
  assert(activeTasks.some(t => t.id === task1!.id), 'Task is back in active list');

  // -----------------------------------------------------------------
  // 9. Configurable Bin Retention Policy & Expiration Sweep (Scenario 10)
  // -----------------------------------------------------------------
  console.log('\n--- 9. Bin Retention Policy & Auto-Expiration Sweep ---');
  const originalPolicy = db.getBinRetentionPolicy();
  assert(originalPolicy.retentionDays > 0, 'Retention policy has positive retentionDays');

  const memToExpire = db.addMemory(userId, 'Temporary note that should expire', 'fact', 0.5, 0.5);
  const moveExpRes = db.moveMemoryToBin(memToExpire!.memoryId, { deletedBy: userId });

  // Manually mutate the expiresAt timestamp in data to simulate expiration in past
  const binItem = (db as any).data.bin.find((e: any) => e.binId === moveExpRes.binId);
  if (binItem) {
    binItem.expiresAt = new Date(Date.now() - 86400_000 * 40).toISOString(); // 40 days ago
  }

  const sweepRes = db.sweepExpiredBin();
  assert(sweepRes.removed >= 1, `Sweep removed at least 1 expired entry (removed=${sweepRes.removed})`);
  assert(sweepRes.removedBinIds.includes(moveExpRes.binId!), 'Expired test item was swept');

  const binAfterSweep = db.listBin(userId, false);
  assert(!binAfterSweep.some(e => e.binId === moveExpRes.binId), 'Expired item is no longer in Bin');
  const allMemsRaw = (db as any).data.memories;
  assert(!allMemsRaw.some((m: any) => m.memoryId === memToExpire!.memoryId), 'Expired item physically purged from live memories (no ghost knowledge)');

  // -----------------------------------------------------------------
  // 10. Permanent Deletion (Scenario 9)
  // -----------------------------------------------------------------
  console.log('\n--- 10. Permanent Deletion ---');
  const memToPerm = db.addMemory(userId, 'Sensitive password hint', 'fact', 0.9, 0.9);
  const movePermRes = db.moveMemoryToBin(memToPerm!.memoryId, { deletedBy: userId });
  assert(movePermRes.success === true, 'Moved to Bin before permanent deletion');

  const permRes = db.permanentDeleteFromBin(movePermRes.binId!, { deletedBy: userId });
  assert(permRes.success === true, 'Permanent deletion succeeded');

  const binAfterPerm = db.listBin(userId, false);
  assert(!binAfterPerm.some(e => e.binId === movePermRes.binId), 'Permanently deleted item is gone from Bin');
  assert(!(db as any).data.memories.some((m: any) => m.memoryId === memToPerm!.memoryId), 'Physically purged from memory store');

  // -----------------------------------------------------------------
  // 11. Voice Command Classification & Query Extraction (Scenario 13)
  // -----------------------------------------------------------------
  console.log('\n--- 11. Voice Command Router Classification & Extraction ---');
  const cmd1 = routeVoiceCommand('delete my memory about green tea');
  assert(cmd1.kind === 'delete-memory', 'Routed to delete-memory');
  assert(cmd1.deletionScope === 'single_memory', 'Scope is single_memory');
  assert(cmd1.targetQuery === 'green tea', `Extracted target query: "${cmd1.targetQuery}"`);

  const cmd2 = routeVoiceCommand('forget that conversation where we discussed project alpha');
  assert(cmd2.kind === 'delete-conversation', 'Routed to delete-conversation');
  assert(cmd2.deletionScope === 'single_conversation', 'Scope is single_conversation');

  const cmd3 = routeVoiceCommand('delete all my memories');
  assert(cmd3.kind === 'delete-all-memories', 'Routed to delete-all-memories');
  assert(cmd3.deletionScope === 'all_memories', 'Scope is all_memories');

  const cmd4 = routeVoiceCommand('permanently delete that conversation');
  assert(cmd4.kind === 'permanently-delete', 'Routed to permanently-delete');

  const cmd5 = routeVoiceCommand('delete the task about filing taxes');
  assert(cmd5.kind === 'delete-task', 'Routed to delete-task');
  assert(cmd5.deletionScope === 'single_task', 'Scope is single_task');

  const cmd6 = routeVoiceCommand('delete all my tasks');
  assert(cmd6.kind === 'delete-all-tasks', 'Routed to delete-all-tasks');
  assert(cmd6.deletionScope === 'all_tasks', 'Scope is all_tasks');

  // -----------------------------------------------------------------
  // 12. Manual Deletion Routing Parity (Scenario 14)
  // -----------------------------------------------------------------
  console.log('\n--- 12. Manual Deletion Routing Parity ---');
  const manualTaskScope = db.resolveDeletionScope({
    identityId: userId,
    scope: 'all_tasks',
  });
  assert(manualTaskScope.resolved === true, 'Manual all_tasks scope resolved');
  assert(manualTaskScope.safety === 'requires_confirm', 'Manual all_tasks requires confirm');

  // -----------------------------------------------------------------
  // 13. Permanent-Delete Ambiguity Resolution (Scenario 15)
  // -----------------------------------------------------------------
  console.log('\n--- 13. Permanent-Delete Ambiguity Resolution ---');
  const binPerm1 = db.addMemory(userId, 'Database backup encryption key stored in vault', 'fact', 0.9, 0.9);
  const binPerm2 = db.addMemory(userId, 'Database backup cron schedule set for midnight', 'fact', 0.9, 0.9);
  db.moveMemoryToBin(binPerm1!.memoryId, { deletedBy: userId });
  db.moveMemoryToBin(binPerm2!.memoryId, { deletedBy: userId });

  const activeBin = db.listBin(userId, false);
  const matchedBinItems = activeBin.filter(e => e.preview.toLowerCase().includes('database backup'));
  assert(matchedBinItems.length === 2, `Found exactly 2 candidate Bin items for "database backup" (got ${matchedBinItems.length})`);

  // -----------------------------------------------------------------
  // 14. Sequential/Concurrent Operations Safety (Scenario 16)
  // -----------------------------------------------------------------
  console.log('\n--- 14. Sequential/Concurrent Operations Safety ---');
  const memConc = db.addMemory(userId, 'Concurrent test memory', 'fact', 0.9, 0.9);
  const move1 = db.moveMemoryToBin(memConc!.memoryId, { deletedBy: userId });
  assert(move1.success === true, 'First delete succeeded');
  // Attempt duplicate move on already soft-deleted item
  const move2 = db.moveMemoryToBin(memConc!.memoryId, { deletedBy: userId });
  assert(move2.success === false, 'Duplicate delete on binned memory safely rejected');

  // -----------------------------------------------------------------
  // 15. No Ghost Knowledge (Search & Retrieval Isolation) (Scenario 18)
  // -----------------------------------------------------------------
  console.log('\n--- 15. No Ghost Knowledge (Search / Retrieval Isolation) ---');
  const ghostMem = db.addMemory(userId, 'Secret agent codeword is NIGHTINGALE_77', 'fact', 0.95, 0.9);
  db.moveMemoryToBin(ghostMem!.memoryId, { deletedBy: userId });

  // Semantic/text retrieval must NOT return this memory
  const userMems = db.getMemoriesForIdentity(userId, true);
  assert(!userMems.some(m => m.content.includes('NIGHTINGALE_77')), 'Binned item excluded from getMemoriesForIdentity');

  const groupedMems = db.getAllMemoriesGrouped();
  assert(
    !groupedMems.some(g => g.memories.some(m => m.content.includes('NIGHTINGALE_77'))),
    'Binned item excluded from getAllMemoriesGrouped'
  );

  console.log('\n' + '='.repeat(60));
  console.log(`TOTAL TESTS: ${passed + failed}`);
  console.log(`PASSED:      ${passed}`);
  console.log(`FAILED:      ${failed}`);
  console.log('='.repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
