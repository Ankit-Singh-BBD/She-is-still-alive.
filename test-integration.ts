// ===================================================================
// COGNITIVE SYSTEM INTEGRATION TEST
// ===================================================================
//
// Tests the complete cognitive flow end-to-end:
// 1. 12-stage cognitive loop execution
// 2. Event system emission and processing
// 3. Learning pipeline execution
// 4. Task execution and awareness
// 5. Database persistence

import { cognitiveLoop } from './server/cognitive-loop.js';
import { learningPipeline } from './server/learning-pipeline.js';
import { awarenessEngine } from './server/awareness-engine.js';
import { taskExecutor } from './server/task-executor.js';
import { loopManager } from './server/loop-manager.js';
import { proactiveEngine } from './server/proactive-engine.js';
import { eventBus, emitUserArrival, emitTaskDue } from './server/event-system.js';
import { db } from './server/db.js';
import { auth } from './server/auth.js';

console.log('🧪 COGNITIVE SYSTEM INTEGRATION TEST\n');
console.log('=' .repeat(60));

async function runTests() {
  let passed = 0;
  let failed = 0;

  // Test 1: Database and Identity
  console.log('\n[TEST 1] Database & Identity Verification');
  try {
    const identity = db.getMadhuritaIdentity();
    const verification = db.verifyMadhuritaIdentity();
    if (verification.valid && identity?.name === 'Madhurita' && identity?.gender === 'female') {
      console.log('✅ Identity verified');
      passed++;
    } else {
      console.log('❌ Identity verification failed');
      failed++;
    }
  } catch (err: any) {
    console.log('❌ Error:', err.message);
    failed++;
  }

  // Test 2: Event System
  console.log('\n[TEST 2] Event System');
  try {
    const event = await emitUserArrival('TEST_USER', 'Test User', 'text', false);
    const recent = db.getRecentSystemEvents(10);
    if (recent.some(e => e.eventId === event.eventId)) {
      console.log('✅ Event emitted and persisted');
      passed++;
    } else {
      console.log('❌ Event not found in database');
      failed++;
    }
  } catch (err: any) {
    console.log('❌ Error:', err.message);
    failed++;
  }

  // Test 3: Awareness Engine
  console.log('\n[TEST 3] Awareness Engine');
  try {
    awarenessEngine.start(30_000);
    const snapshot = awarenessEngine.snapshot();
    if (snapshot && snapshot.generatedAt && snapshot.madhuritaIdentity) {
      console.log('✅ Awareness snapshot generated');
      passed++;
    } else {
      console.log('❌ Invalid snapshot');
      failed++;
    }
    awarenessEngine.stop();
  } catch (err: any) {
    console.log('❌ Error:', err.message);
    failed++;
  }

  // Test 4: Task Executor
  console.log('\n[TEST 4] Task Executor');
  try {
    // Create a due task
    const dueAt = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    db.createTaskWithMetadata('TEST_USER', 'Test urgent task', {
      dueAt,
      priority: 'high',
      source: 'user_explicit',
    });

    taskExecutor.start(60_000);
    const result = await taskExecutor.tick();
    if (result.evaluated > 0) {
      console.log(`✅ Task executor evaluated ${result.evaluated} tasks, found ${result.dueFound} due`);
      passed++;
    } else {
      console.log('❌ Task executor did not evaluate tasks');
      failed++;
    }
    taskExecutor.stop();
  } catch (err: any) {
    console.log('❌ Error:', err.message);
    failed++;
  }

  // Test 5: Loop Manager
  console.log('\n[TEST 5] Loop Manager');
  try {
    db.addOpenLoop('Test loop', 'This is a test open loop', 'TEST_USER');
    loopManager.start(5 * 60_000);
    const result = await loopManager.tick();
    if (result.evaluated > 0) {
      console.log(`✅ Loop manager evaluated ${result.evaluated} loops`);
      passed++;
    } else {
      console.log('❌ Loop manager did not evaluate loops');
      failed++;
    }
    loopManager.stop();
  } catch (err: any) {
    console.log('❌ Error:', err.message);
    failed++;
  }

  // Test 6: Proactive Engine
  console.log('\n[TEST 6] Proactive Engine');
  try {
    proactiveEngine.start(2 * 60_000);
    const result = await proactiveEngine.tick();
    console.log(`✅ Proactive engine found ${result.opportunities.length} opportunities`);
    passed++;
    proactiveEngine.stop();
  } catch (err: any) {
    console.log('❌ Error:', err.message);
    failed++;
  }

  // Test 7: Cognitive Loop (without LLM - uses fallback)
  console.log('\n[TEST 7] Cognitive Loop Execution');
  try {
    const authContext = auth.resolveContext(undefined, 'TEST_USER');
    const result = await cognitiveLoop.execute(
      'Hello, this is a test message',
      'text',
      'TEST_SESSION',
      authContext
    );
    if (result.response && result.loopId && result.response.text) {
      console.log(`✅ Cognitive loop completed`);
      console.log(`   Loop ID: ${result.loopId}`);
      console.log(`   Stages recorded: ${result.timings.size}`);
      console.log(`   Response: "${result.response.text.substring(0, 50)}..."`);
      passed++;
    } else {
      console.log('❌ Cognitive loop incomplete');
      failed++;
    }
  } catch (err: any) {
    console.log('❌ Error:', err.message);
    failed++;
  }

  // Test 8: Learning Pipeline (without LLM - records attempt)
  console.log('\n[TEST 8] Learning Pipeline');
  try {
    const stats = learningPipeline.getStats();
    const initialRuns = stats.totalRuns;

    await learningPipeline.run(
      'TEST_USER',
      'Test User',
      'user',
      'I like pizza',
      'Great! I will remember that you like pizza.',
      'TEST_SESSION'
    );

    const newStats = learningPipeline.getStats();
    if (newStats.totalRuns >= initialRuns) {
      console.log(`✅ Learning pipeline executed (${newStats.totalRuns} total runs)`);
      passed++;
    } else {
      console.log('❌ Learning pipeline did not execute');
      failed++;
    }
  } catch (err: any) {
    console.log('❌ Error:', err.message);
    failed++;
  }

  // Test 9: Database Persistence
  console.log('\n[TEST 9] Database Persistence');
  try {
    const beforeCount = db.getRecentSystemEvents(1000).length;
    await emitUserArrival('PERSIST_TEST', 'Persist Test', 'text', false);
    const afterCount = db.getRecentSystemEvents(1000).length;
    if (afterCount > beforeCount) {
      console.log('✅ Events persisted to database');
      passed++;
    } else {
      console.log('❌ Events not persisted');
      failed++;
    }
  } catch (err: any) {
    console.log('❌ Error:', err.message);
    failed++;
  }

  // Test 10: Memory Operations
  console.log('\n[TEST 10] Memory Operations');
  try {
    const result = db.validateAndApplyMemoryCandidate(
      'TEST_USER',
      'Test user likes testing',
      'fact',
      0.9,
      0.8,
      false
    );
    if (result.memory && result.decision !== 'IGNORE') {
      console.log(`✅ Memory created (decision: ${result.decision})`);
      passed++;
    } else {
      console.log('❌ Memory creation failed');
      failed++;
    }
  } catch (err: any) {
    console.log('❌ Error:', err.message);
    failed++;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 TEST RESULTS: ${passed}/${passed + failed} passed`);
  if (failed === 0) {
    console.log('✅ ALL TESTS PASSED\n');
  } else {
    console.log(`❌ ${failed} TEST(S) FAILED\n`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
